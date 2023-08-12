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
  rotation_id: number;
  album_id: number;
  artist_name: string;
  album_title: string;
  requst_flag?: boolean;
};

// either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id 0
export const addEntry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res, next) => {
  //check for things that MUST be sent by the client
  // const body = req.body;
  // if (body.show_id === undefined || body.rotation_id === undefined || body.track_title === undefined) {
  //   console.error('Missing required entry parameters');
  //   res.status(400);
  //   res.send('Missing required entry parameters: show_id, rotation_id, track_title');
  // } else if (body.rotation_id === 0 && (body.album_id == undefined || body.album_id === 0) && (!body.album_title)) {
  //   console.error('Missing album identifier');
  //   res.send(400);
  //   res.send('Missing required entry parameter: either album_id or album_title');
  // } else {
  //   try {
  //     const entry_obj = await addTrack(body);
  //   } catch (e) {
  //     console.error('Error: Failed to add flowsheet entry');
  //     console.error(`Error: ${e}`);
  //   }
  // }
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
