/**
 * Mock LML (library-metadata-lookup) routes.
 *
 * Simulates the /api/v1/discogs/* endpoints that the Backend-Service calls
 * via its LML client.
 */

import { Router, type Request, type Response } from 'express';
import { recordRequest, checkErrorRule } from '../state.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, '../fixtures/lml.json'), 'utf8'));

const router = Router();

/** Middleware: record every request and check error rules. */
router.use((req: Request, res: Response, next) => {
  recordRequest({
    service: 'lml',
    method: req.method,
    path: req.path,
    query: req.query as Record<string, string>,
    body: req.body,
    timestamp: new Date().toISOString(),
  });

  const error = checkErrorRule('lml', req.path);
  if (error) {
    res.status(error.status).json(error.body ?? { error: `Simulated ${error.status}` });
    return;
  }

  next();
});

/** POST /api/v1/discogs/search */
router.post('/api/v1/discogs/search', (req: Request, res: Response) => {
  const { artist, album } = req.body ?? {};
  if (!artist) {
    res.status(400).json({ error: 'artist is required' });
    return;
  }

  const key = (artist as string).toLowerCase();
  const searchData = fixtures.search as Record<string, unknown>;
  const match = searchData[key];

  if (match) {
    res.json(match);
  } else {
    res.json({ results: [], total: 0, cached: false });
  }
});

/** GET /api/v1/discogs/release/:id */
router.get('/api/v1/discogs/release/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const releaseData = fixtures.releases as Record<string, unknown>;
  const release = releaseData[id];

  if (release) {
    res.json(release);
  } else {
    res.status(404).json({ error: `Release ${id} not found` });
  }
});

/** GET /api/v1/discogs/artist/:id */
router.get('/api/v1/discogs/artist/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const artistData = fixtures.artists as Record<string, unknown>;
  const artist = artistData[id];

  if (artist) {
    res.json(artist);
  } else {
    res.status(404).json({ error: `Artist ${id} not found` });
  }
});

/** GET /api/v1/discogs/entity/:type/:id */
router.get('/api/v1/discogs/entity/:type/:id', (req: Request, res: Response) => {
  const key = `${req.params.type}:${req.params.id}`;
  const entityData = fixtures.entities as Record<string, unknown>;
  const entity = entityData[key];

  if (entity) {
    res.json(entity);
  } else {
    res.status(404).json({ error: `Entity ${key} not found` });
  }
});

/** GET /api/v1/discogs/track-releases */
router.get('/api/v1/discogs/track-releases', (req: Request, res: Response) => {
  const track = (req.query.track as string)?.toLowerCase();
  if (!track) {
    res.status(400).json({ error: 'track query parameter is required' });
    return;
  }

  const trackData = fixtures.trackReleases as Record<string, unknown>;
  const match = trackData[track];

  if (match) {
    res.json(match);
  } else {
    res.json({ track, artist: null, releases: [], total: 0, cached: false });
  }
});

export default router;
