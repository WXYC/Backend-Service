import { Router } from 'express';
import * as proxyController from '../controllers/proxy.controller.js';
import { requireAnonymousAuth } from '../middleware/anonymousAuth.js';
import { proxyRateLimit } from '../middleware/rateLimiting.js';

export const proxy_route = Router();

// All proxy routes require anonymous auth + rate limiting
proxy_route.use(requireAnonymousAuth, proxyRateLimit);

proxy_route.get('/artwork/search', proxyController.searchArtwork);
proxy_route.get('/metadata/album', proxyController.getAlbumMetadata);
proxy_route.get('/metadata/artist', proxyController.getArtistMetadata);
proxy_route.get('/entity/resolve', proxyController.resolveEntity);
proxy_route.get('/spotify/track/:id', proxyController.getSpotifyTrack);
