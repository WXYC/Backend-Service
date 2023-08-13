import { Request, RequestHandler } from 'express';
import { NewFSEntry, FSEntry } from '../db/schema';
import * as flowsheet_service from '../services/flowsheet.service';

type QueryParams = {
  page: number;
  n: number;
  start_date: string;
  end_date: string;
};

export interface IFSEntry extends FSEntry {
  rotation_play_freq: string;
}

export const getEntries: RequestHandler<object, unknown, object, QueryParams> = async (req, res, next) => {
  const { query } = req;
  const page = query.page || 0;
  const limit = query.n || 5;
  const offset = page * query.n;

  try {
    const entries: IFSEntry[] = await flowsheet_service.getEntriesFromDB(offset, limit);
    if (entries.length) {
      console.log(entries);
      res.status(200);
      res.json(entries);
    } else {
      console.error('No Tracks found');
      res.status(404);
      res.send('Error: No Tracks found');
    }
  } catch (e) {
    console.error('Failed to retrieve tracks');
    console.error(`Error: ${e}`);
    next(e);
  }
};

export const getLatest: RequestHandler = async (req, res, next) => {
  try {
    const latest: FSEntry[] = await flowsheet_service.getEntriesFromDB(0, 1);
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
  show_id: number;
  track_title: string;
  rotation_id?: number;
  album_id?: number;
  artist_name: string;
  album_title: string;
  requst_flag?: boolean;
  message?: string;
};

// either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id = NULL
export const addEntry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res, next) => {
  //check for things that MUST be sent by the client
  const { body } = req;
  if (body.show_id === undefined) {
    console.error('Bad Request, Missing show identifier: show_id');
    res.status(400).send('Bad Request, Missing show identifier: show_id');
  } else if (body.message === undefined) {
    // no message passed, so we assume we're adding a track to the flowsheet
    if (body.album_id !== undefined) {
      //backfill album info from library before adding to flowsheet
      console.log('todo');
    } else if (body.album_title !== undefined || body.artist_name === undefined || body.track_title === undefined) {
      console.error('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title');
      res.status(400).send('Bad Request, Missing Flowsheet Parameters: album_title, artist_name, track_title');
    } else {
      // todo: add raw info into the fs
    }
  } else {
    //we're just throwing the message in there (whatever it may be): dj join event, psa event, talk set event, break-point
  }
  res.status(200);
  res.send('TODO');
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
      const show_session = flowsheet_service.addDJToShow(req.body.dj_id, req.body.show_name, req.body.specialty_id);
      res.status(200);
      res.json(show_session);
    } catch (e) {
      console.error('Error: Failed to join show');
      console.error(e);
      next(e);
    }
  }
};
