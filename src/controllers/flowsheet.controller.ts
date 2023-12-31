import { Request, RequestHandler } from 'express';
import { NewFSEntry, FSEntry } from '../db/schema';
import * as flowsheet_service from '../services/flowsheet.service';

type QueryParams = {
  page: number;
  limit: number;
  start_id: number;
  end_id: number;
};

export interface IFSEntry extends FSEntry {
  rotation_play_freq: string | null;
}

const MAX_ITEMS = 200;
const OFFSET = 10; //This offsets the ID's not representing the actual number of tracks due to deletions
export const getEntries: RequestHandler<object, unknown, object, QueryParams> = async (req, res, next) => {
  const { query } = req;
  const page = query.page || 0;
  const limit = query.limit || 5;
  const offset = page * query.limit;
  if (query.end_id - query.start_id + OFFSET > MAX_ITEMS || limit > MAX_ITEMS) {
    res.status(400).json({
      message: 'Requested too many entries',
    });
  } else {
    try {
      const entries: IFSEntry[] =
        query.start_id !== undefined && query.end_id !== undefined
          ? await flowsheet_service.getEntriesByRange(query.start_id, query.end_id)
          : await flowsheet_service.getEntriesByPage(offset, limit);
      if (entries.length) {
        res.status(200).json(entries);
      } else {
        console.error('No Tracks found');
        res.status(404).json({
          message: 'No Tracks found',
        });
      }
    } catch (e) {
      console.error('Failed to retrieve tracks');
      console.error(`Error: ${e}`);
      next(e);
    }
  }
};

export const getLatest: RequestHandler = async (req, res, next) => {
  try {
    const latest: FSEntry[] = await flowsheet_service.getEntriesByPage(0, 1);
    if (latest.length) {
      console.log(latest[0]);
      res.status(200);
      res.json(latest[0]);
    } else {
      console.error('No Tracks found');
      res.status(404);
      res.send('Error: No Tracks found');
    }
  } catch (e) {
    console.error('Error: Failed to retrieve track');
    console.error(`Error: ${e}`);
    next(e);
  }
};

export type FSEntryRequestBody = {
  artist_name: string;
  album_title: string;
  track_title: string;
  album_id?: number;
  rotation_id?: number;
  record_label: string;
  request_flag?: boolean;
  message?: string;
};

// either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id = NULL
export const addEntry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res, next) => {
  const { body } = req;
  let latestShow;
  try {
    latestShow = await flowsheet_service.getLatestShow();
  } catch (e) {
    console.error('Error: Failed to retrieve most recent show ');
    console.error(e);
  }
  if (latestShow === undefined || latestShow.end_time !== null) {
    console.error('Bad Request, There are no active shows');
    res.status(400).send('Bad Request, There are no active shows');
  } else {
    if (body.message === undefined) {
      // no message passed, so we assume we're adding a track to the flowsheet
      if (body.track_title === undefined) {
        console.error('Bad Request, Missing query parameter: track_title');
        res.status(400).send('Bad Request, Missing query parameter: track_title');
      } else {
        try {
          if (body.album_id !== undefined) {
            //backfill album info from library before adding to flowsheet
            const albumInfo = await flowsheet_service.getAlbumFromDB(body.album_id);

            const fsEntry: NewFSEntry = {
              album_id: body.album_id,
              ...albumInfo,
              track_title: body.track_title,
              rotation_id: body.rotation_id,
              request_flag: body.request_flag,
            };

            const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);

            res.status(200).json(completedEntry);
          } else if (
            body.album_title === undefined ||
            body.artist_name === undefined ||
            body.track_title === undefined
          ) {
            console.error('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title');
            res.status(400).send('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title');
          } else {
            const fsEntry: NewFSEntry = {
              ...body,
            };

            const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
            res.status(200).json(completedEntry);
          }
        } catch (e) {
          console.error('Error: Failed to add track to flowsheet');
          console.error(e);
          next(e);
        }
      }
    } else {
      //we're just throwing the message in there (whatever it may be): dj join event, psa event, talk set event, break-point
      const fsEntry: NewFSEntry = {
        artist_name: '',
        album_title: '',
        track_title: '',
        message: body.message,
      };
      try {
        const completedEntry: FSEntry = await flowsheet_service.addTrack(fsEntry);
        res.status(200).json(completedEntry);
      } catch (e) {
        console.error('Error: Failed to add message to flowsheet');
        console.error(e);
        next(e);
      }
    }
  }
};

export const deleteEntry: RequestHandler<object, unknown, { entry_id: number }> = async (req, res, next) => {
  const { entry_id } = req.body;
  if (entry_id === undefined) {
    console.error('Bad Request, Missing entry identifier: entry_id');
    res.status(400).send('Bad Request, Missing entry identifier: entry_id');
  } else {
    try {
      const removedEntry = await flowsheet_service.removeTrack(entry_id);
      res.status(200).json(removedEntry);
    } catch (e) {
      console.error('Error: Failed to remove entry');
      console.error(e);
      next(e);
    }
  }
};

export type UpdateRequestBody = {
  artist_name?: string;
  album_title?: string;
  track_title?: string;
  record_label?: string;
  rotation_id?: number;
  request_flag?: boolean;
  message?: string;
};

export const updateEntry: RequestHandler<object, unknown, { entry_id: number; data: UpdateRequestBody }> = async (
  req,
  res,
  next
) => {
  const { entry_id, data } = req.body;
  if (entry_id === undefined) {
    console.error('Bad Request, Missing entry identifier: entry_id');
    res.status(400).send('Bad Request, Missing entry identifier: entry_id');
  } else {
    try {
      const updatedEntry = await flowsheet_service.patchTrack(entry_id, data);
      res.status(200).json(updatedEntry);
    } catch (e) {
      console.error('Error: Failed to update entry');
      console.error(e);
      next(e);
    }
  }
};

export type JoinRequestBody = {
  dj_id: number;
  show_name?: string;
  specialty_id?: number;
};

//POST
export const joinShow: RequestHandler = async (req: Request<object, object, JoinRequestBody>, res, next) => {
  if (req.body.dj_id === undefined) {
    res.status(400).send('Error: Must include a dj_id to join show');
  } else {
    try {
      const show_session = await flowsheet_service.addDJToShow(
        req.body.dj_id,
        req.body.show_name,
        req.body.specialty_id
      );

      res.status(200).json(show_session);
    } catch (e) {
      console.error('Error: Failed to join show');
      console.error(e);
      next(e);
    }
  }
};

//GET
//TODO consume JWT and ensure that jwt.dj_id = current_show.dj_id
export const leaveShow: RequestHandler<object, unknown, { dj_id: number }> = async (req, res, next) => {
  let finalizedShow;
  try {
    finalizedShow = await flowsheet_service.leaveShow(Number(req.body.dj_id));
    if (finalizedShow.id === undefined) {
      res.status(400).send('Bad Request, no active shows for dj');
    } else {
      res.status(200).json(finalizedShow);
    }
  } catch (e) {
    console.error('Error: Failed to leave show');
    console.error(e);
    next(e);
  }
};

export const getDJList: RequestHandler = async (req, res, next) => {
  try {
    const currentDJs = await flowsheet_service.getDJsInCurrentShow();
    res.status(200).json(currentDJs);
  } catch (e) {
    console.error('Error: Failed to retrieve current DJs');
    console.error(e);
    next(e);
  }
};

export const getOnAir: RequestHandler = async (req, res, next) => {
  const { dj_id } = req.query;
  try {
    const currentShow = await flowsheet_service.getOnAirStatusForDJ(Number(dj_id));
    res.status(200).json(currentShow);
  } catch (e) {
    console.error('Error: Failed to retrieve current show');
    console.error(e);
    next(e);
  }
};
