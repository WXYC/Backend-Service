import { RequestHandler } from 'express';
import * as DJService from '../services/djs.service';
import { NewBinEntry } from '@wxyc/database';
import WxycError from '../utils/error.js';

export type binBody = {
  dj_id: string;
  bin_entry_id?: number;
  album_id?: number;
  track_title?: string;
};

export const addToBin: RequestHandler<object, unknown, binBody> = async (req, res, next) => {
  if (req.body.album_id === undefined || req.body.dj_id === undefined) {
    throw new WxycError('Bad Request, Missing DJ or album identifier: album_id', 400);
  }

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
};

export type binQuery = {
  dj_id: string;
  bin_entry_id?: string;
  album_id?: string;
  track_title?: string;
};

export const deleteFromBin: RequestHandler<object, unknown, unknown, binQuery> = async (req, res, next) => {
  if (req.query.album_id === undefined || req.query.dj_id === undefined) {
    throw new WxycError('Bad Request, Missing Bin Entry Identifier: album_id or dj_id', 400);
  }

  try {
    //check that the dj_id === dj_id of bin entry
    const removed_bin_item = await DJService.removeFromBin(parseInt(req.query.album_id), req.query.dj_id);
    res.status(200).json(removed_bin_item);
  } catch (e) {
    console.error(e);
    next(e);
  }
};

export const getBin: RequestHandler<object, unknown, object, { dj_id: string }> = async (req, res, next) => {
  if (req.query.dj_id === undefined) {
    throw new WxycError('Bad Request, Missing DJ Identifier: dj_id', 400);
  }

  try {
    const dj_bin = await DJService.getBinFromDB(req.query.dj_id);
    res.status(200).json(dj_bin);
  } catch (e) {
    console.error("Error: Failed to retrieve dj's bin");
    console.error(e);
    next(e);
  }
};

export const getPlaylistsForDJ: RequestHandler<object, unknown, object, { dj_id: string }> = async (req, res, next) => {
  if (req.query.dj_id === undefined) {
    throw new WxycError('Bad Request, Missing DJ Identifier: dj_id', 400);
  }

  try {
    const playlists = await DJService.getPlaylistsForDJ(req.query.dj_id);
    res.status(200).json(playlists);
  } catch (e) {
    console.error('Error: Failed to retrieve playlists');
    console.error(e);
    next(e);
  }
};

export const getPlaylist: RequestHandler<object, unknown, object, { playlist_id: string }> = async (req, res, next) => {
  if (req.query.playlist_id === undefined) {
    throw new WxycError('Bad Request, Missing Playlist Identifier: playlist_id', 400);
  }

  try {
    const playlist = await DJService.getPlaylist(parseInt(req.query.playlist_id));
    res.status(200).json(playlist);
  } catch (e) {
    console.error('Error: Failed to retrieve playlist');
    console.error(e);
    next(e);
  }
};
