import { RequestHandler } from 'express';
import * as PlaylistService from '../services/playlist.service';

export const getPlaylistsForDJ: RequestHandler<object, unknown, object, { dj_id: number }> = async (req, res, next) => {
    if (req.query.dj_id === undefined) {
        console.error('Bad Request, Missing DJ Identifier: dj_id');
        res.status(400).send('Bad Request, Missing DJ Identifier: dj_id');
    } else {
        try {
        const playlists = await PlaylistService.getPlaylistsForDJ(req.query.dj_id);
        res.status(200).json(playlists);
        } catch (e) {
        console.error('Error: Failed to retrieve playlists');
        console.error(e);
        next(e);
        }
    }
};

export const getPlaylist: RequestHandler<object, unknown, object, { playlist_id: number }> = async (req, res, next) => {
    if (req.query.playlist_id === undefined) {
        console.error('Bad Request, Missing Playlist Identifier: playlist_id');
        res.status(400).send('Bad Request, Missing Playlist Identifier: playlist_id');
    } else {
        try {
        const playlist = await PlaylistService.getPlaylist(req.query.playlist_id);
        res.status(200).json(playlist);
        } catch (e) {
        console.error('Error: Failed to retrieve playlist');
        console.error(e);
        next(e);
        }
    }
}