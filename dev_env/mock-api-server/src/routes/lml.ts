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

/** POST /api/v1/lookup — wraps search fixtures into LookupResponse format.
 *
 * Two modes:
 *
 *  - Artist-driven (`artist` populated): looks up the `search` fixture keyed on
 *    artist name and synthesizes library_item.id from the result index. Used
 *    by the artist/album lookup path.
 *  - Song-driven (`artist` absent, `song` populated): looks up the
 *    `songLookup` fixture keyed on lowercased song title. Returns the fixture
 *    response verbatim (library_item.id is real `library.legacy_release_id`,
 *    not synthesized), so Backend-Service's `searchLibraryByTrack` can bridge
 *    to the seeded library row. Used by the Track 2 catalog-track-search
 *    cascade (BS#825 — lookupBySong sends only `song` + `raw_message`).
 */
router.post('/api/v1/lookup', (req: Request, res: Response) => {
  const { artist, song } = req.body ?? {};

  // Song-only path: matches LML's SONG_AS_TRACK strategy entry shape.
  if (!artist) {
    if (!song) {
      res.status(400).json({ error: 'artist or song is required' });
      return;
    }
    const songKey = (song as string).toLowerCase();
    const songLookup = (fixtures.songLookup ?? {}) as Record<string, unknown>;
    const songMatch = songLookup[songKey];
    if (songMatch) {
      res.json(songMatch);
    } else {
      res.json({
        results: [],
        search_type: 'none',
        song_not_found: true,
        found_on_compilation: false,
        cache_stats: { memory_hits: 0, pg_hits: 0, pg_misses: 0, api_calls: 0, pg_time_ms: 0, api_time_ms: 0 },
      });
    }
    return;
  }

  const key = (artist as string).toLowerCase();
  const searchData = fixtures.search as Record<string, { results: Array<Record<string, unknown>> }>;
  const match = searchData[key];

  if (match && match.results.length > 0) {
    const results = match.results.map((r: Record<string, unknown>, i: number) => ({
      library_item: {
        id: i + 1,
        title: r.album ?? '',
        artist: r.artist ?? '',
        call_number: `Mock CD ${i + 1}`,
        library_url: `https://library.wxyc.org/mock/${i + 1}`,
      },
      artwork: r,
    }));
    res.json({ results, search_type: 'direct', song_not_found: false, found_on_compilation: false });
  } else {
    res.json({ results: [], search_type: 'none', song_not_found: false, found_on_compilation: false });
  }
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
