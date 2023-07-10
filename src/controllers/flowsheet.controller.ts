import { RequestHandler } from 'express';
import { NewFSEntry, FSEntry } from '../db/schema';
import { getTracks } from '../services/flowsheet.service';

type QueryParams = {
  page: number;
  limit: number;
  start_date: string;
  end_date: string;
};

export const get: RequestHandler = async (req, res, next) => {
  console.log('Get Flowsheet Data');
  const query = req.query as unknown as QueryParams;
  if (query.page && query.limit) {
    const offset = query.page * query.limit;
    const limit = query.limit;

    try {
      const tracks: FSEntry[] = await getTracks(offset, limit);
      if (tracks.length) {
        console.log(tracks);
        res.status(200);
        res.json(tracks);
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
  } else {
    res.status(400);
    res.send('Error: page and limit parameters required');
  }
};

export const getLatest: RequestHandler = async (req, res, next) => {
  try {
    const latest: FSEntry[] = await getTracks(0, 1);
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

export const add_entry: RequestHandler = async (req, res, next) => {
  //check for things that MUST be sent by the client
  if (!(req.body.show_id && req.body.rotation_id && req.body.track_title)) {
    console.error('Missing required entry parameters parameters');
    res.status(400);
    res.send('Missing required entry parameters: show_id, rotation_id, or track_title');
  } else {
    res.send('placeholder');
  }
};
