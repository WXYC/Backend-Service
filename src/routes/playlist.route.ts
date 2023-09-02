import { Router } from 'express';
import * as playlistController from '../controllers/playlist.controller';

export const playlist_route = Router();

playlist_route.get('/', playlistController.getPlaylistsForDJ);

playlist_route.get('/playlist', playlistController.getPlaylist);
