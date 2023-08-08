import { RequestHandler } from 'express';
import * as DJService from '../services/djs.service';
import { DJ, NewDJ } from '../db/schema';

export const register: RequestHandler = async (req, res, next) => {
  console.log('registering new user');
  console.log(req.body);
  if (!(req.body.real_name && req.body.dj_name && req.body.email)) {
    console.log('Bad Request: Missing New DJ Parameters');
    res.status(400);
    res.send('Bad Request: Missing New DJ Parameters');
  } else {
    const new_dj: NewDJ = {
      real_name: req.body.real_name,
      dj_name: req.body.dj_name,
      email: req.body.email,
    };

    try {
      const dj_obj = await DJService.insertDJ(new_dj);
      res.status(200);
      res.json(dj_obj);
    } catch (e) {
      console.error(`Failed To Create DJ`);
      console.error(`Error: ${e}`);
      next(e);
      // res.status(500);
      // res.send('Server Error: Failed to create DJ');
    }
  }
  console.log('----------------------------');
};

export type DJQueryParams = {
  id: number;
  email: string;
  dj_name: string;
  real_name: string;
};

export const info: RequestHandler<object, unknown, object, DJQueryParams> = async (req, res, next) => {
  const query = req.query;
  try {
    const dj_info: DJ[] = await DJService.getDJInfo(query);
    if (dj_info.length) {
      console.log(dj_info[0]);
      res.status(200);
      res.send(dj_info);
    } else {
      console.error('DJ not found');
      res.status(404).send('DJ not found');
    }
  } catch (e) {
    console.error('Error looking up DJ');
    console.error(`Error: ${e}`);
    next(e);
  }
};

export type binQueryString = {
  method: string;
};

export type binBody = {
  dj_id: number;
  album_id: number;
  song_title?: string;
};

export const binUpdater: RequestHandler<object, unknown, object, binQueryString, binBody> = async (req, res, next) => {
  if (req.query.method === 'remove') {
    console.log('todo');
  } else {
    //assume we're adding an album/song to bin
    console.log('todo');
  }
  res.status(501).send('todo');
};

// export const getBin: RequestHandler = async
