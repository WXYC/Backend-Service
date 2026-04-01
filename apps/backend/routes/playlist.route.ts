/**
 * Playlist route.
 *
 * Serves the enriched playlist proxy at /playlists/recentEntries.
 * No authentication required — matches tubafrenzy's public API.
 */
import { Router } from 'express';
import * as playlistController from '../controllers/playlist.controller.js';

export const playlist_route = Router();

// GET /playlists/recentEntries - enriched playlist proxy
playlist_route.get('/recentEntries', playlistController.getRecentEntries);
