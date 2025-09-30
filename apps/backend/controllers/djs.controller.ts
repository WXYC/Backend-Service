import { RequestHandler } from 'express';
import * as DJService from '../services/djs.service.js';
import { DJ, NewDJ, NewBinEntry } from '@wxyc/database';

export type DJQueryParams = {
  user_id?: string;
  real_name?: string;
  dj_name?: string;
};

export const register: RequestHandler<object, unknown, DJQueryParams> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }
  
  const new_dj: NewDJ = {
    user_id: user.id,
    real_name: req.body.real_name || user.realName,
    dj_name: req.body.dj_name || user.djName,
  };

  try {
    const dj_obj = await DJService.insertDJ(new_dj);
    res.status(200).json(dj_obj);
  } catch (e) {
    console.error(`Failed To Create DJ`);
    console.error(e);
    next(e);
  }
};

export const update: RequestHandler<object, unknown, DJQueryParams> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }
  
  const new_dj: NewDJ = {
    user_id: user.id,
    real_name: req.body.real_name || user.realName,
    dj_name: req.body.dj_name || user.djName,
  };

  try {
    const dj_obj = await DJService.updateDJ(new_dj);
    res.status(200).json(dj_obj);
  } catch (e) {
    console.error(`Failed To Update DJ`);
    console.error(e);
    next(e);
  }
};

export const getDJInfo: RequestHandler<object, unknown, object, DJQueryParams> = async (req, res, next) => {
  const { query } = req;
  const user = (req as any).user;

  // If no specific query params, get info for authenticated user
  if (query.user_id === undefined && query.real_name === undefined && query.dj_name === undefined) {
    if (!user?.id) {
      console.error('Error, Missing DJ Identifier: user not authenticated');
      res.status(401).send('Error, Missing DJ Identifier: user not authenticated');
      return;
    }
    // Use authenticated user's ID
    query.user_id = user.id;
  }
  
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
};

export type binBody = {
  album_id?: number;
  track_title?: string;
};

export const addToBin: RequestHandler<object, unknown, binBody> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }

  if (req.body.album_id === undefined) {
    console.error('Bad Request, Missing Album Identifier: album_id');
    res.status(400).send('Bad Request, Missing album identifier: album_id');
    return;
  }

  const bin_entry: NewBinEntry = {
    dj_id: user.id,
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
  album_id?: string;
  track_title?: string;
};

export const deleteFromBin: RequestHandler<object, unknown, unknown, binQuery> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }

  if (req.query.album_id === undefined) {
    console.error('Bad Request, Missing Bin Entry Identifier: album_id');
    res.status(400).send('Bad Request, Missing Bin Entry Identifier: album_id');
    return;
  }

  try {
    const removed_bin_item = await DJService.removeFromBin(parseInt(req.query.album_id), user.id);
    res.status(200).json(removed_bin_item);
  } catch (e) {
    console.error(e);
    next(e);
  }
};

export const getBin: RequestHandler<object, unknown, object, object> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }

  try {
    const dj_bin = await DJService.getBinFromDB(user.id);
    res.status(200).json(dj_bin);
  } catch (e) {
    console.error("Error: Failed to retrieve dj's bin");
    console.error(e);
    next(e);
  }
};

export const getPlaylistsForDJ: RequestHandler<object, unknown, object, object> = async (req, res, next) => {
  const user = (req as any).user;
  if (!user?.id) {
    console.log('Bad Request: User not authenticated');
    res.status(401).send('Bad Request: User not authenticated');
    return;
  }

  try {
    const playlists = await DJService.getPlaylistsForDJ(user.id);
    res.status(200).json(playlists);
  } catch (e) {
    console.error('Error: Failed to retrieve playlists');
    console.error(e);
    next(e);
  }
};

export const getPlaylist: RequestHandler<object, unknown, object, { playlist_id: string }> = async (req, res, next) => {
  if (req.query.playlist_id === undefined) {
    console.error('Bad Request, Missing Playlist Identifier: playlist_id');
    res.status(400).send('Bad Request, Missing Playlist Identifier: playlist_id');
  } else {
    try {
      const playlist = await DJService.getPlaylist(parseInt(req.query.playlist_id));
      res.status(200).json(playlist);
    } catch (e) {
      console.error('Error: Failed to retrieve playlist');
      console.error(e);
      next(e);
    }
  }
};
