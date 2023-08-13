import { RequestHandler } from 'express';
import * as DJService from '../services/djs.service';
import { DJ, NewDJ, NewBinEntry } from '../db/schema';

export type DJQueryParams = {
  dj_id?: number;
  cognito_user_name?: string;
  real_name?: string;
};

export const register: RequestHandler<object, unknown, DJQueryParams> = async (req, res, next) => {
  if (req.body.cognito_user_name === undefined) {
    console.log('Bad Request: Missing New DJ Parameters');
    res.status(400).send('Bad Request: Missing New DJ Parameters');
  } else {
    const new_dj: NewDJ = {
      cognito_user_name: req.body.cognito_user_name,
      real_name: req.body.real_name,
    };

    try {
      const dj_obj = await DJService.insertDJ(new_dj);
      res.status(200).json(dj_obj);
    } catch (e) {
      console.error(`Failed To Create DJ`);
      console.error(e);
      next(e);
    }
  }
};

export const getDJInfo: RequestHandler<object, unknown, object, DJQueryParams> = async (req, res, next) => {
  const { query } = req;

  if (query.cognito_user_name === undefined && query.dj_id === undefined) {
    console.error('Error, Missing DJ Identifier: cognito_user_name or id');
    res.status(400).send('Error, Missing DJ Identifier: cognito_user_name or id');
  } else {
    try {
      const dj_info: DJ = await DJService.getDJInfoFromDB(query);
      if (dj_info !== undefined) {
        console.log(dj_info);
        res.status(200);
        res.send(dj_info);
      } else {
        console.error('DJ not found');
        res.status(404).send('DJ not found');
      }
    } catch (e) {
      console.error('Error looking up DJ');
      console.error(e);
      next(e);
    }
  }
};

export type binQuery = {
  dj_id: number;
  bin_entry_id?: number;
  album_id?: number;
  track_title?: string;
};

export const addToBin: RequestHandler<object, unknown, binQuery> = async (req, res, next) => {
  if (req.body.album_id === undefined || req.body.dj_id === undefined) {
    console.error('Bad Request, Missing Album Identifier: album_id');
    res.status(400).send('Bad Request, Missing DJ or album identifier: album_id');
  } else {
    const bin_entry: NewBinEntry = {
      dj_id: req.body.dj_id,
      album_id: req.body.album_id,
      track_title: req.body.track_title === undefined ? null : req.body.track_title,
    };
    try {
      const added_bin_item = await DJService.addToBin(bin_entry);
      res.status(200).json(added_bin_item);
    } catch (e) {
      console.error('Server error: Failed to insert into bin');
      console.error(e);
      next(e);
    }
  }
};

export const deleteFromBin: RequestHandler<object, unknown, object, binQuery> = async (req, res, next) => {
  if (req.query.bin_entry_id === undefined || req.query.dj_id) {
    console.error('Bad Request, Missing Bin Entry Identifier: bin_entry_id');
    res.status(400).send('Bad Request, Missing Bin Entry Identifier: bin_entry_id');
  } else {
    try {
      //check that the dj_id === dj_id of bin entry
      const removed_bin_item = await DJService.removeFromBin(req.query.bin_entry_id, req.query.dj_id);
      res.status(200).json(removed_bin_item);
    } catch (e) {
      console.error(e);
      next(e);
    }
  }
};

export const getBin: RequestHandler = async (req, res, next) => {
  res.send('todo');
};
