import { RequestHandler } from 'express';
import * as DJService from '../services/djs.service';
import { DJ, NewDJ, NewBinEntry } from '../db/schema';

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
      res.status(200).json(dj_obj);
    } catch (e) {
      console.error(`Failed To Create DJ`);
      console.error(`Error: ${e}`);
      next(e);
      // res.status(500);
      // res.send('Server Error: Failed to create DJ');
    }
  }
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

export type binQuery = {
  dj_id: number;
  bin_entry_id?: number;
  album_id?: number;
  track_title?: string;
};

export const addToBin: RequestHandler<object, unknown, object, binQuery> = async (req, res, next) => {
  if (req.query.album_id === undefined || req.query.dj_id === undefined) {
    console.error('Error Missing Album Identifier: album_id');
    res.send(400).send('Error Missing DJ or album identifier: dj_id or album_id');
  } else {
    const bin_entry: NewBinEntry = {
      dj_id: req.query.dj_id,
      album_id: req.query.album_id,
      track_title: req.query.track_title === undefined ? null : req.query.track_title,
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
    console.error('Error, Missing Bin Entry Identifier: bin_entry_id');
    res.send(400).send('Error, Missing Bin Entry Identifier: bin_entry_id');
  } else {
    try {
      //check that the dj_id === dj_id of bin entry
      const removed_bin_item = await DJService.removeFromBin(req.query.bin_entry_id, req.query.dj_id);
      res.send(200).json(removed_bin_item);
    } catch (e) {
      console.error(e);
      next(e);
    }
  }
};

export const getBin: RequestHandler = async (req, res, next) => {
  res.send('todo');
};
