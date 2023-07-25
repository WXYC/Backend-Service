import { Request, RequestHandler } from 'express';
import { NewFSEntry, FSEntry } from '../db/schema';
import { getTracks /*addTrack*/ } from '../services/flowsheet.service';

type QueryParams = {
  page: number;
  limit: number;
  start_date: string;
  end_date: string;
};

export const get: RequestHandler = async (req, res, next) => {
  console.log('Get Flowsheet Data');
  const query = req.query as unknown as QueryParams;
  if (!(query.page === undefined || query.limit === undefined)) {
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

export type FSEntryRequestBody = {
  show_id: number;
  track_title: string;
  rotation_id: number;
  album_id: number;
  artist_name: string;
  album_title: string;
  requst_flag?: boolean;
};

//either an id is provided (meaning it came from the user's bin or was fuzzy found)
// or it's not provided in which case whe just throw the data provided into the table w/ album_id 0
export const add_entry: RequestHandler = async (req: Request<object, object, FSEntryRequestBody>, res, next) => {
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

/*Minimum info:
Always: show_id, rotation_id, track_title
Sometimes: request_flag
Album_identifier: rotation_id, album_id, or (album_title & artist_name)
*/
