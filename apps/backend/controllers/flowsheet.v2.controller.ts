import { Request, RequestHandler } from 'express';
import { Mutex } from 'async-mutex';
import { NewFSEntry, FSEntry, Show, ShowDJ } from "@wxyc/database";
import * as flowsheet_service from '../services/flowsheet.service.js';
import { fetchAndCacheMetadata } from '../services/metadata/index.js';
import { IFSEntry } from './flowsheet.controller.js';

export type QueryParams = {
  page?: string;
  limit?: string;
  start_id?: string;
  end_id?: string;
  shows_limit?: string;
  entry_type?: string;
};

const MAX_ITEMS = 200;
const DELETION_OFFSET = 10;

/**
 * GET /v2/flowsheet
 * Returns flowsheet entries in V2 discriminated union format
 */
export const getEntries: RequestHandler<object, unknown, object, QueryParams> = async (req, res, next) => {
  const { query } = req;

  const page = parseInt(query.page ?? '0');
  const limit = parseInt(query.limit ?? '30');
  const offset = page * limit;

  if (query.shows_limit !== undefined) {
    try {
      const numberOfShows = parseInt(query.shows_limit);
      if (isNaN(numberOfShows) || numberOfShows < 1) {
        res.status(400).json({
          message: 'shows_limit must be a positive number',
        });
        return;
      }
      const recentShows = await flowsheet_service.getNShows(numberOfShows, page);
      const entries = await flowsheet_service.getEntriesByShow(...recentShows.map((show) => show.id));

      if (entries.length) {
        // Transform to V2 format
        const v2Entries = entries.map((entry) => flowsheet_service.transformToV2(entry));
        res.status(200).json(v2Entries);
      } else {
        res.status(404).json({
          message: 'No entries found',
        });
      }
      return;
    } catch (e) {
      console.error('Failed to retrieve entries from previous shows');
      console.error(`Error: ${e}`);
      next(e);
      return;
    }
  }

  if (
    parseInt(query.end_id ?? '0') - parseInt(query.start_id ?? '0') - DELETION_OFFSET > MAX_ITEMS ||
    limit > MAX_ITEMS
  ) {
    res.status(400).json({
      message: 'Requested too many entries',
    });
  } else if (isNaN(limit) || limit < 1) {
    res.status(400).json({
      message: 'limit must be a positive number',
    });
  } else {
    try {
      const entries: IFSEntry[] =
        query.start_id !== undefined && query.end_id !== undefined
          ? await flowsheet_service.getEntriesByRange(parseInt(query.start_id), parseInt(query.end_id))
          : await flowsheet_service.getEntriesByPage(offset, limit);

      if (entries.length) {
        // Transform to V2 format
        const v2Entries = entries.map((entry) => flowsheet_service.transformToV2(entry));
        res.status(200).json(v2Entries);
      } else {
        console.error('No entries found');
        res.status(404).json({
          message: 'No entries found',
        });
      }
    } catch (e) {
      console.error('Failed to retrieve entries');
      console.error(`Error: ${e}`);
      next(e);
    }
  }
};

/**
 * GET /v2/flowsheet/latest
 * Returns the latest flowsheet entry in V2 format
 */
export const getLatest: RequestHandler = async (req, res, next) => {
  try {
    const latest: IFSEntry[] = await flowsheet_service.getEntriesByPage(0, 1);
    if (latest.length) {
      const v2Entry = flowsheet_service.transformToV2(latest[0]);
      res.status(200).json(v2Entry);
    } else {
      console.error('No entries found');
      res.status(404).json({ message: 'No entries found' });
    }
  } catch (e) {
    console.error('Error: Failed to retrieve entry');
    console.error(`Error: ${e}`);
    next(e);
  }
};

export type AddTrackRequestBody = {
  artist_name?: string;
  album_title?: string;
  track_title: string;
  album_id?: number;
  rotation_id?: number;
  record_label?: string;
  request_flag?: boolean;
};

/**
 * POST /v2/flowsheet/track
 * Add a track entry to the flowsheet
 */
export const addTrack: RequestHandler = async (req: Request<object, object, AddTrackRequestBody>, res, next) => {
  const { body } = req;
  let latestShow;
  try {
    latestShow = await flowsheet_service.getLatestShow();
  } catch (e) {
    console.error('Error: Failed to retrieve most recent show');
    console.error(e);
  }

  if (latestShow?.end_time !== null) {
    console.error('Bad Request: No active show');
    res.status(400).json({ message: 'No active show' });
    return;
  }

  if (body.track_title === undefined) {
    console.error('Bad Request: Missing track_title');
    res.status(400).json({ message: 'Missing required field: track_title' });
    return;
  }

  try {
    let fsEntry: NewFSEntry;

    if (body.album_id !== undefined) {
      // Backfill album info from library
      const albumInfo = await flowsheet_service.getAlbumFromDB(body.album_id);

      fsEntry = {
        album_id: body.album_id,
        ...albumInfo,
        record_label: body.record_label ?? albumInfo.record_label,
        track_title: body.track_title,
        rotation_id: body.rotation_id,
        request_flag: body.request_flag,
        show_id: latestShow.id,
        entry_type: 'track',
      };
    } else if (body.album_title === undefined || body.artist_name === undefined) {
      console.error('Bad Request: Missing album_title or artist_name');
      res.status(400).json({
        message: 'When album_id is not provided, album_title and artist_name are required',
      });
      return;
    } else {
      fsEntry = {
        ...body,
        show_id: latestShow.id,
        entry_type: 'track',
      };
    }

    const completedEntry: FSEntry = await flowsheet_service.addTrackV2(fsEntry);

    // Fire-and-forget: fetch metadata
    if (completedEntry.artist_name) {
      fetchAndCacheMetadata({
        albumId: completedEntry.album_id ?? undefined,
        artistId: undefined,
        rotationId: completedEntry.rotation_id ?? undefined,
        artistName: completedEntry.artist_name,
        albumTitle: completedEntry.album_title ?? undefined,
        trackTitle: completedEntry.track_title ?? undefined,
      }).catch((err) => console.error('[Flowsheet V2] Metadata fetch failed:', err));
    }

    res.status(200).json(completedEntry);
  } catch (e) {
    console.error('Error: Failed to add track');
    console.error(e);
    next(e);
  }
};

export type AddTalksetRequestBody = {
  message: string;
};

/**
 * POST /v2/flowsheet/talkset
 * Add a talkset entry (DJ talk segment, announcements, station ID)
 */
export const addTalkset: RequestHandler = async (req: Request<object, object, AddTalksetRequestBody>, res, next) => {
  const { body } = req;
  let latestShow;
  try {
    latestShow = await flowsheet_service.getLatestShow();
  } catch (e) {
    console.error('Error: Failed to retrieve most recent show');
    console.error(e);
  }

  if (latestShow?.end_time !== null) {
    res.status(400).json({ message: 'No active show' });
    return;
  }

  if (!body.message || body.message.trim() === '') {
    res.status(400).json({ message: 'Missing required field: message' });
    return;
  }

  try {
    const entry = await flowsheet_service.addTalkset(latestShow.id, body.message);
    res.status(200).json(entry);
  } catch (e) {
    console.error('Error: Failed to add talkset');
    console.error(e);
    next(e);
  }
};

export type AddBreakpointRequestBody = {
  message?: string;
};

/**
 * POST /v2/flowsheet/breakpoint
 * Add a breakpoint entry (hour marker, top of hour transitions)
 */
export const addBreakpoint: RequestHandler = async (
  req: Request<object, object, AddBreakpointRequestBody>,
  res,
  next
) => {
  const { body } = req;
  let latestShow;
  try {
    latestShow = await flowsheet_service.getLatestShow();
  } catch (e) {
    console.error('Error: Failed to retrieve most recent show');
    console.error(e);
  }

  if (latestShow?.end_time !== null) {
    res.status(400).json({ message: 'No active show' });
    return;
  }

  try {
    const entry = await flowsheet_service.addBreakpoint(latestShow.id, body.message);
    res.status(200).json(entry);
  } catch (e) {
    console.error('Error: Failed to add breakpoint');
    console.error(e);
    next(e);
  }
};

export type AddMessageRequestBody = {
  message: string;
};

/**
 * POST /v2/flowsheet/message
 * Add a custom message entry
 */
export const addMessage: RequestHandler = async (req: Request<object, object, AddMessageRequestBody>, res, next) => {
  const { body } = req;
  let latestShow;
  try {
    latestShow = await flowsheet_service.getLatestShow();
  } catch (e) {
    console.error('Error: Failed to retrieve most recent show');
    console.error(e);
  }

  if (latestShow?.end_time !== null) {
    res.status(400).json({ message: 'No active show' });
    return;
  }

  if (!body.message || body.message.trim() === '') {
    res.status(400).json({ message: 'Missing required field: message' });
    return;
  }

  try {
    const entry = await flowsheet_service.addMessage(latestShow.id, body.message);
    res.status(200).json(entry);
  } catch (e) {
    console.error('Error: Failed to add message');
    console.error(e);
    next(e);
  }
};

export type UpdateRequestBody = {
  artist_name?: string;
  album_title?: string;
  track_title?: string;
  record_label?: string;
  request_flag?: boolean;
  message?: string;
};

/**
 * PATCH /v2/flowsheet/:id
 * Update an existing flowsheet entry
 */
export const updateEntry: RequestHandler<{ id: string }, unknown, UpdateRequestBody> = async (req, res, next) => {
  const entryId = parseInt(req.params.id);
  const { body } = req;

  if (isNaN(entryId)) {
    res.status(400).json({ message: 'Invalid entry ID' });
    return;
  }

  try {
    const updatedEntry: FSEntry = await flowsheet_service.updateEntry(entryId, body);
    res.status(200).json(updatedEntry);
  } catch (e) {
    console.error('Error: Failed to update entry');
    console.error(e);
    next(e);
  }
};

/**
 * DELETE /v2/flowsheet/:id
 * Delete a flowsheet entry
 */
export const deleteEntry: RequestHandler<{ id: string }> = async (req, res, next) => {
  const entryId = parseInt(req.params.id);

  if (isNaN(entryId)) {
    res.status(400).json({ message: 'Invalid entry ID' });
    return;
  }

  try {
    const removedEntry: FSEntry = await flowsheet_service.removeTrack(entryId);
    res.status(200).json(removedEntry);
  } catch (e) {
    console.error('Error: Failed to delete entry');
    console.error(e);
    next(e);
  }
};

export type JoinRequestBody = {
  dj_id: string;
  show_name?: string;
  specialty_id?: number;
};

/**
 * POST /v2/flowsheet/join
 * Join or start a show
 */
export const joinShow: RequestHandler = async (req: Request<object, object, JoinRequestBody>, res, next) => {
  const current_show = await flowsheet_service.getLatestShow();

  if (req.body.dj_id === undefined) {
    res.status(400).json({ message: 'Missing required field: dj_id' });
    return;
  }

  if (current_show?.end_time !== null) {
    // No active show - start a new one
    try {
      const show_session: Show = await flowsheet_service.startShow(
        req.body.dj_id,
        req.body.show_name,
        req.body.specialty_id
      );
      res.status(200).json(show_session);
    } catch (e) {
      console.error('Error: Failed to start show');
      console.error(e);
      next(e);
    }
  } else {
    // Active show exists - join it
    try {
      const show_dj_instance: ShowDJ = await flowsheet_service.addDJToShow(req.body.dj_id, current_show);
      res.status(200).json(show_dj_instance);
    } catch (e) {
      console.error('Error: Failed to join show');
      console.error(e);
      next(e);
    }
  }
};

/**
 * POST /v2/flowsheet/end
 * Leave or end a show
 */
export const leaveShow: RequestHandler<object, unknown, { dj_id: string }> = async (req, res, next) => {
  const currentShow = await flowsheet_service.getLatestShow();

  if (currentShow?.end_time !== null) {
    res.status(404).json({ message: 'No active show session found' });
    return;
  }

  try {
    const show_djs = await flowsheet_service.getDJsInCurrentShow();
    if (!show_djs.map((dj) => dj.id).includes(req.body.dj_id)) {
      res.status(400).json({ message: 'DJ not in current show' });
      return;
    }

    if (req.body.dj_id === currentShow.primary_dj_id) {
      // Primary DJ leaving - end the show
      const finalizedShow: Show = await flowsheet_service.endShow(currentShow);
      res.status(200).json(finalizedShow);
    } else {
      // Guest DJ leaving
      const showDJ: ShowDJ = await flowsheet_service.leaveShow(req.body.dj_id, currentShow);
      res.status(200).json(showDJ);
    }
  } catch (e) {
    console.error('Error: Failed to leave show');
    console.error(e);
    next(e);
  }
};

/**
 * GET /v2/flowsheet/on-air
 * Check if a DJ is currently on air
 */
export const getOnAir: RequestHandler = async (req, res, next) => {
  const { dj_id } = req.query;

  try {
    const isActive = await flowsheet_service.getOnAirStatusForDJ(dj_id as string);
    res.status(200).json({ id: dj_id, is_live: isActive });
  } catch (e) {
    console.error('Error: Failed to retrieve on-air status');
    console.error(e);
    next(e);
  }
};

/**
 * GET /v2/flowsheet/djs-on-air
 * Get list of DJs currently on air
 */
export const getDJList: RequestHandler = async (req, res, next) => {
  try {
    const currentDJs = await flowsheet_service.getDJsInCurrentShow();
    const cleanDJList = currentDJs.map((dj) => ({
      id: dj.id,
      dj_name: dj.djName || dj.name,
    }));
    res.status(200).json(cleanDJList);
  } catch (e) {
    console.error('Error: Failed to retrieve current DJs');
    console.error(e);
    next(e);
  }
};

/**
 * GET /v2/flowsheet/playlist
 * Get show info with all entries
 */
export const getShowInfo: RequestHandler<object, unknown, object, { show_id: string }> = async (req, res, next) => {
  const showId = parseInt(req.query.show_id);

  if (isNaN(showId)) {
    res.status(400).json({ message: 'Missing or invalid show_id parameter' });
    return;
  }

  try {
    const showInfo = await flowsheet_service.getPlaylist(showId);
    res.status(200).json(showInfo);
  } catch (e) {
    console.error('Error: Failed to retrieve playlist');
    console.error(e);
    next(e);
  }
};

const orderMutex = new Mutex();

/**
 * PATCH /v2/flowsheet/play-order
 * Change the play order of an entry
 */
export const changeOrder: RequestHandler<object, unknown, { entry_id: number; new_position: number }> = async (
  req,
  res,
  next
) => {
  const { entry_id, new_position } = req.body;

  if (entry_id === undefined || new_position === undefined) {
    res.status(400).json({ message: 'entry_id and new_position are required' });
    return;
  }

  const release = await orderMutex.acquire();
  try {
    const updatedEntry = await flowsheet_service.changeOrder(entry_id, new_position);
    res.status(200).json(updatedEntry);
  } catch (e) {
    console.error('Error: Failed to change order');
    console.error(e);
    next(e);
  } finally {
    release();
  }
};
