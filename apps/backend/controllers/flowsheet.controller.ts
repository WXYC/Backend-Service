import { Request, RequestHandler } from 'express';
import { Mutex } from 'async-mutex';
import * as Sentry from '@sentry/node';
import { eq } from 'drizzle-orm';
import { db, NewFSEntry as FullNewFSEntry, FSEntry, Show, ShowDJ, flowsheet } from '@wxyc/database';

// play_order is computed by the service layer, not provided by controllers
type NewFSEntry = Omit<FullNewFSEntry, 'play_order'>;
import * as flowsheet_service from '../services/flowsheet.service.js';
import { fetchMetadata } from '../services/metadata/index.js';
import { runLmlLinkage } from '../services/flowsheet-linkage.service.js';
import { reportLinkageError } from '../services/linkage-metrics.service.js';
import WxycError from '../utils/error.js';

export type QueryParams = {
  page?: string;
  limit?: string;
  start_id?: string;
  end_id?: string;
  shows_limit?: string;
};

export interface IFSEntryMetadata {
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
}

// search_doc is a STORED GENERATED tsvector used only by the search hot path
// (apps/backend/services/search.service.ts); the controller layer never reads
// or constructs it, so it is excluded from the application-facing entry type.
export interface IFSEntry extends Omit<FSEntry, 'search_doc' | 'legacy_link_attempted_at'> {
  label_id: number | null;
  rotation_bin: string | null;
  on_streaming: boolean | null;
  metadata: IFSEntryMetadata;
}

/**
 * Fire-and-forget: fetch metadata from LML and update the flowsheet row.
 *
 * Called after a track is inserted. Does not block the HTTP response.
 */
/**
 * Fire-and-forget: resolve a canonical entity via LML and link the row to a
 * library album when there's a single high-confidence match (B-2.1). Only
 * fires for free-form inserts (no album_id) — bin-picks already carry an
 * album_id from the catalog click. Logs every non-link outcome at info level
 * so the operator can spot pattern shifts without a metric pipeline.
 */
function fireAndForgetLinkage(completedEntry: FSEntry): void {
  if (completedEntry.album_id !== null) return;
  if (!completedEntry.artist_name) return;

  runLmlLinkage({
    flowsheetId: completedEntry.id,
    artistName: completedEntry.artist_name,
    albumTitle: completedEntry.album_title,
  })
    .then((outcome) => {
      if (outcome.status === 'linked') return;
      console.info(
        `[Flowsheet] LML linkage outcome=${outcome.status} flowsheet_id=${completedEntry.id} artist="${completedEntry.artist_name}" album="${completedEntry.album_title ?? ''}"`
      );
    })
    .catch((err) => {
      // Safety net: runLmlLinkage handles LML errors itself (counter +
      // Sentry tag), so this only fires on unexpected bugs in the linkage
      // path (e.g., a DB write throwing). Route through the same surface so
      // the operator sees one consistent `subsystem='lml-linkage'` filter.
      console.error('[Flowsheet] LML linkage failed:', err);
      reportLinkageError(
        err,
        {
          flowsheetId: completedEntry.id,
          artistName: completedEntry.artist_name,
          albumTitle: completedEntry.album_title,
        },
        { path: 'forward' }
      );
    });
}

function fireAndForgetMetadata(completedEntry: FSEntry, artistId?: number): void {
  if (!completedEntry.artist_name) return;

  fetchMetadata({
    albumId: completedEntry.album_id ?? undefined,
    artistId,
    artistName: completedEntry.artist_name,
    albumTitle: completedEntry.album_title ?? undefined,
    trackTitle: completedEntry.track_title ?? undefined,
  })
    .then(async (metadata) => {
      if (!metadata) return;
      await db
        .update(flowsheet)
        .set({
          artwork_url: metadata.album?.artworkUrl ?? null,
          discogs_url: metadata.album?.discogsUrl ?? null,
          release_year: metadata.album?.releaseYear ?? null,
          spotify_url: metadata.album?.spotifyUrl ?? null,
          apple_music_url: metadata.album?.appleMusicUrl ?? null,
          youtube_music_url: metadata.album?.youtubeMusicUrl ?? null,
          bandcamp_url: metadata.album?.bandcampUrl ?? null,
          soundcloud_url: metadata.album?.soundcloudUrl ?? null,
          artist_bio: metadata.artist?.bio ?? null,
          artist_wikipedia_url: metadata.artist?.wikipediaUrl ?? null,
        })
        .where(eq(flowsheet.id, completedEntry.id));
    })
    .catch((err) => {
      console.error('[Flowsheet] Metadata fetch failed:', err);
      Sentry.captureException(err, {
        tags: { subsystem: 'metadata' },
        extra: { artistName: completedEntry.artist_name, albumTitle: completedEntry.album_title },
      });
    });
}

const MAX_ITEMS = 200;
const DELETION_OFFSET = 10; //This offsets the ID's not representing the actual number of tracks due to deletions
export const getEntries: RequestHandler<object, unknown, object, QueryParams> = async (req, res) => {
  const { query } = req;

  const page = parseInt(query.page ?? '0');
  const limit = parseInt(query.limit ?? '30');

  if (query.shows_limit !== undefined) {
    const numberOfShows = parseInt(query.shows_limit);
    if (isNaN(numberOfShows) || numberOfShows < 1) {
      throw new WxycError('shows_limit must be a positive number', 400);
    }
    const recentShows = await flowsheet_service.getNShows(numberOfShows, page);
    const entries = await flowsheet_service.getEntriesByShow(...recentShows.map((show) => show.id));

    if (entries.length) {
      res.status(200).json(entries.map(flowsheet_service.transformToV2));
    } else {
      res.status(404).json({
        message: 'No Tracks found',
      });
    }
    return;
  }

  if (query.start_id !== undefined && query.end_id !== undefined) {
    if (parseInt(query.end_id) - parseInt(query.start_id) - DELETION_OFFSET > MAX_ITEMS) {
      throw new WxycError('Requested too many entries', 400);
    }
    const entries = await flowsheet_service.getEntriesByRange(parseInt(query.start_id), parseInt(query.end_id));
    if (entries.length) {
      res.status(200).json(entries.map(flowsheet_service.transformToV2));
    } else {
      res.status(404).json({ message: 'No Tracks found' });
    }
    return;
  }

  // Default: paginated entries with discriminated union format
  if (isNaN(limit) || limit < 1) throw new WxycError('limit must be a positive number', 400);
  if (limit > MAX_ITEMS) throw new WxycError('Requested too many entries', 400);
  if (isNaN(page) || page < 0) throw new WxycError('page must be a non-negative number', 400);

  const offset = page * limit;
  const [entries, total] = await Promise.all([
    flowsheet_service.getEntriesByPage(offset, limit),
    flowsheet_service.getEntryCount(),
  ]);

  const totalPages = Math.ceil(total / limit);

  res.status(200).json({
    entries: entries.map(flowsheet_service.transformToV2),
    total,
    page,
    limit,
    totalPages,
  });
};

export const getLatest: RequestHandler = async (req, res) => {
  const entries = await flowsheet_service.getEntriesByPage(0, 1);
  if (entries.length) {
    res.status(200).json(flowsheet_service.transformToV2(entries[0]));
  } else {
    res.status(204).end();
  }
};

/**
 * Infer the entry_type from the message content, matching the
 * discriminated union in wxyc-shared's FlowsheetEntryType.
 */
function inferMessageEntryType(message: string | undefined): NewFSEntry['entry_type'] {
  if (message?.includes('Talkset')) return 'talkset';
  if (message?.includes('Breakpoint')) return 'breakpoint';
  return 'message';
}

export type FSEntryRequestBody = {
  artist_name: string;
  album_title: string;
  track_title: string;
  album_id?: number;
  rotation_id?: number;
  record_label: string;
  label_id?: number;
  request_flag?: boolean;
  segue?: boolean;
  message?: string;
  entry_type?: NewFSEntry['entry_type'];
};

// either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id = NULL
export const addEntry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res) => {
  const { body } = req;
  const latestShow = await flowsheet_service.getLatestShow();
  if (latestShow?.end_time !== null) {
    throw new WxycError('Bad Request, There are no active shows', 400);
  }

  // Resolved once per request and denormalized onto every new flowsheet row
  // (step 5b.2). Mirrors the search service's DJ_NAME_EXPR so the search hot
  // path can read flowsheet.dj_name directly without joining shows -> auth_user.
  const dj_name = await flowsheet_service.resolveDjNameForShow(latestShow);

  if (body.message !== undefined) {
    //we're just throwing the message in there (whatever it may be): dj join event, psa event, talk set event, break-point
    const fsEntry: NewFSEntry = {
      artist_name: '',
      album_title: '',
      track_title: '',
      entry_type: body.entry_type ?? inferMessageEntryType(body.message),
      message: body.message,
      show_id: latestShow.id,
      dj_name,
    };
    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    res.status(201).json(completedEntry);
    return;
  }

  // no message passed, so we assume we're adding a track to the flowsheet
  if (body.track_title === undefined) {
    throw new WxycError('Bad Request, Missing query parameter: track_title', 400);
  }

  if (body.album_id !== undefined) {
    //backfill album info from library before adding to flowsheet
    const albumInfo = await flowsheet_service.getAlbumFromDB(body.album_id);

    if (body.record_label !== undefined) {
      albumInfo.record_label = body.record_label;
    }

    const fsEntry: NewFSEntry = {
      album_id: body.album_id,
      ...albumInfo,
      track_title: body.track_title,
      rotation_id: body.rotation_id,
      request_flag: body.request_flag,
      segue: body.segue ?? false,
      show_id: latestShow.id,
      dj_name,
    };

    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    fireAndForgetMetadata(completedEntry, albumInfo.artist_id ?? undefined);
    res.status(201).json(completedEntry);
  } else if (body.album_title === undefined || body.artist_name === undefined || body.track_title === undefined) {
    throw new WxycError('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title', 400);
  } else {
    const fsEntry: NewFSEntry = {
      ...body,
      show_id: latestShow.id,
      dj_name,
    };

    const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
    fireAndForgetMetadata(completedEntry);
    fireAndForgetLinkage(completedEntry);
    res.status(201).json(completedEntry);
  }
};

export const deleteEntry: RequestHandler<object, unknown, { entry_id: number }> = async (req, res) => {
  const { entry_id } = req.body;
  if (entry_id === undefined) {
    throw new WxycError('Bad Request, Missing entry identifier: entry_id', 400);
  }

  const removedEntry: FSEntry = await flowsheet_service.removeTrack(entry_id);
  res.status(200).json(removedEntry);
};

export type UpdateRequestBody = {
  artist_name?: string;
  album_title?: string;
  track_title?: string;
  record_label?: string;
  label_id?: number;
  request_flag?: boolean;
  segue?: boolean;
  message?: string;
};

export const updateEntry: RequestHandler<object, unknown, { entry_id: number; data: UpdateRequestBody }> = async (
  req,
  res
) => {
  const { entry_id, data } = req.body;
  if (entry_id === undefined) {
    throw new WxycError('Bad Request, Missing entry identifier: entry_id', 400);
  }

  const updatedEntry: FSEntry = await flowsheet_service.updateEntry(entry_id, data);
  res.status(200).json(updatedEntry);
};

export type JoinRequestBody = {
  dj_id: string;
  show_name?: string;
  specialty_id?: number;
};

//POST
export const joinShow: RequestHandler = async (req: Request<object, object, JoinRequestBody>, res) => {
  const current_show = await flowsheet_service.getLatestShow();
  if (req.body.dj_id === undefined) {
    throw new WxycError('Bad Request, Must include a dj_id to join show', 400);
  }

  if (current_show?.end_time !== null) {
    const show_session: Show = await flowsheet_service.startShow(
      req.body.dj_id,
      req.body.show_name,
      req.body.specialty_id
    );

    res.status(200).json(show_session);
  } else {
    const show_dj_instance: ShowDJ = await flowsheet_service.addDJToShow(req.body.dj_id, current_show);
    res.status(200).json(show_dj_instance);
  }
};

//TODO consume JWT and ensure that jwt.dj_id = current_show.dj_id
export const leaveShow: RequestHandler<object, unknown, { dj_id: string }> = async (req, res) => {
  const currentShow = await flowsheet_service.getLatestShow();
  if (currentShow?.end_time !== null) {
    throw new WxycError('Bad Request: No active show session found.', 400);
  }

  // Show membership is verified by showMemberMiddleware on the route
  if (req.body.dj_id === currentShow.primary_dj_id) {
    const finalizedShow: Show = await flowsheet_service.endShow(currentShow);
    res.status(200).json(finalizedShow);
  } else {
    const showDJ: ShowDJ = await flowsheet_service.leaveShow(req.body.dj_id, currentShow);
    res.status(200).json(showDJ);
  }
};

export const getDJList: RequestHandler = async (req, res) => {
  const currentDJs = await flowsheet_service.getDJsInCurrentShow();
  const cleanDJList = currentDJs.map((dj) => {
    return { id: dj.id, dj_name: dj.djName || dj.name };
  });
  res.status(200).json(cleanDJList);
};

export const getOnAir: RequestHandler = async (req, res) => {
  const { dj_id } = req.query;

  const isActive = await flowsheet_service.getOnAirStatusForDJ(dj_id as string);
  res.status(200).json({ id: dj_id, is_live: isActive });
};

// Accepts a request body with entry_id and new_position, where
//    entry_id is the id of the entry to be moved
//    new_position is the new position of the entry
// Positions are serialized starting at 1 and define the play order of the tracks per show
const orderMutex = new Mutex();

export const changeOrder: RequestHandler<object, unknown, { entry_id: number; new_position: number }> = async (
  req,
  res
) => {
  const { entry_id, new_position } = req.body;

  if (entry_id === undefined || new_position === undefined) {
    throw new WxycError('Bad Request: entry_id and new_position are required', 400);
  }

  const release = await orderMutex.acquire();
  try {
    const updatedEntry = await flowsheet_service.changeOrder(entry_id, new_position);
    res.status(200).json(updatedEntry);
  } finally {
    release();
  }
};

export interface ShowMetadata extends Show {
  specialty_show_name: string;
  show_djs: { id: string | null; dj_name: string | null }[];
}

export interface ShowInfo extends ShowMetadata {
  entries: FSEntry[];
}

export const getShowInfo: RequestHandler<object, unknown, object, { show_id: string }> = async (req, res) => {
  const showId = parseInt(req.query.show_id);

  if (isNaN(showId)) throw new WxycError('Missing or invalid show_id parameter', 400);

  const [showMetadata, entries] = await Promise.all([
    flowsheet_service.getShowMetadata(showId),
    flowsheet_service.getEntriesByShow(showId),
  ]);

  res.status(200).json({
    ...showMetadata,
    entries: entries.map(flowsheet_service.transformToV2),
  });
};
