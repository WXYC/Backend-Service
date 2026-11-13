/**
 * The extended fill's probe (BS#1442): what one album's fetch would add, and
 * the tally the probe logs before anyone raises the rate or runs a canary.
 *
 * The probe never writes. What it must get right is which columns a row would
 * gain, so the per-column fill rate it reports is the one the write would see.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { DiscogsArtistDetails, DiscogsReleaseMetadata } from '@wxyc/lml-client';
import type { FillCandidate } from '../../../../jobs/album-metadata-extended-fill/cohort';
import type { Fetched, LmlFetcher } from '../../../../jobs/album-metadata-extended-fill/fetch';
import { EXTENDED_COLUMNS } from '../../../../jobs/album-metadata-extended-fill/map';
import {
  addProbeAlbum,
  emptyProbeTotals,
  probeAlbum,
  summarizeProbe,
} from '../../../../jobs/album-metadata-extended-fill/probe';

// The generated DTOs require every defaulted field; the probe reads only these.
const RELEASE = {
  release_id: 1442,
  title: 'DOGA',
  artist: 'Juana Molina',
  release_url: 'https://www.discogs.com/release/1442',
  artist_id: 82730,
  artists: [{ artist_id: 82730, name: 'Juana Molina', join: '' }],
  label: 'Sonamos',
  released: '2024-05-10',
  genres: ['Electronic'],
  styles: ['Experimental'],
  tracklist: [{ position: 'A1', title: 'la paradoja' }],
  cached: true,
} as unknown as DiscogsReleaseMetadata;
const ARTIST = {
  artist_id: 82730,
  name: 'Juana Molina',
  image_url: 'https://i.discogs.com/a/82730.jpg',
  profile_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
} as unknown as DiscogsArtistDetails;

const candidate = (overrides: Partial<FillCandidate> = {}): FillCandidate => ({
  album_id: 1,
  discogs_url: 'https://www.discogs.com/release/1442-DOGA',
  has_bio: true,
  has_wikipedia_url: false,
  missing: [...EXTENDED_COLUMNS],
  legacy_release_id: null,
  ...overrides,
});

const fetcher = (
  release: Fetched<DiscogsReleaseMetadata>,
  artist: Fetched<DiscogsArtistDetails> = { ok: true, value: ARTIST }
): LmlFetcher & { release: jest.Mock; artist: jest.Mock } => ({
  release: jest.fn(() => Promise.resolve(release)),
  artist: jest.fn(() => Promise.resolve(artist)),
  pins: jest.fn(() => Promise.resolve({ ok: true as const, value: [] })),
  calls: () => 0,
});

describe('probeAlbum', () => {
  it('reads the release the stored URL names, then its artist, and reports every missing column', async () => {
    const lml = fetcher({ ok: true, value: RELEASE, latencyMs: 40 });

    const album = await probeAlbum(candidate(), lml);

    expect(lml.release).toHaveBeenCalledWith(1442);
    expect(lml.artist).toHaveBeenCalledWith(82730);
    expect(album).toMatchObject({
      outcome: 'would_fill',
      gate: 'single',
      cached: true,
      wouldFill: [...EXTENDED_COLUMNS],
    });
  });

  it('only counts columns the row still lacks', async () => {
    const album = await probeAlbum(candidate({ missing: ['tracklist'] }), fetcher({ ok: true, value: RELEASE }));

    expect(album.wouldFill).toEqual(['tracklist']);
  });

  it('reports nothing_new when no missing column gains a value', async () => {
    const bare = { ...RELEASE, tracklist: [], genres: [], styles: [], label: null, released: null };
    const album = await probeAlbum(candidate({ missing: ['tracklist', 'label'] }), fetcher({ ok: true, value: bare }));

    expect(album).toMatchObject({ outcome: 'nothing_new', wouldFill: [] });
  });

  it('never counts bio_tokens for a row with no bio', async () => {
    const album = await probeAlbum(candidate({ has_bio: false }), fetcher({ ok: true, value: RELEASE }));

    expect(album.wouldFill).not.toContain('bio_tokens');
    expect(album.wouldFill).toContain('artist_image_url');
  });

  it.each([
    ['the Various artist', { artist_id: 194 }, 'various'],
    [
      'two primary credits',
      {
        artists: [
          { artist_id: 1, name: 'A', join: ' & ' },
          { artist_id: 2, name: 'B', join: '' },
        ],
      },
      'multiple_credits',
    ],
    ['no artist id', { artist_id: null }, 'no_artist_id'],
  ])('fetches no artist for %s and fills only the release columns', async (_label, overrides, gate) => {
    const lml = fetcher({ ok: true, value: { ...RELEASE, ...overrides } });

    const album = await probeAlbum(candidate(), lml);

    expect(lml.artist).not.toHaveBeenCalled();
    expect(album.gate).toBe(gate);
    expect(album.wouldFill).toEqual(['tracklist', 'genres', 'styles', 'label', 'full_release_date']);
  });

  it.each([
    [404, 'release_not_found_suspected'],
    [502, 'release_unanswered'],
    [504, 'release_unanswered'],
  ])('reports a release %s as %s and asks for no artist', async (status, outcome) => {
    const lml = fetcher({ ok: false, status });

    expect(await probeAlbum(candidate(), lml)).toMatchObject({ outcome, wouldFill: [] });
    expect(lml.artist).not.toHaveBeenCalled();
  });

  it('keeps the release columns when the artist fetch fails, and records the failure', async () => {
    const album = await probeAlbum(candidate(), fetcher({ ok: true, value: RELEASE }, { ok: false, status: 404 }));

    expect(album).toMatchObject({ outcome: 'would_fill', artistStatus: 404 });
    expect(album.wouldFill).not.toContain('artist_image_url');
    expect(album.wouldFill).toContain('discogs_artist_id');
  });

  it('makes no call for a URL with no release id', async () => {
    const lml = fetcher({ ok: true, value: RELEASE });

    expect(await probeAlbum(candidate({ discogs_url: 'https://www.discogs.com/release/0' }), lml)).toMatchObject({
      outcome: 'no_release_id',
    });
    expect(lml.release).not.toHaveBeenCalled();
  });

  it('carries the over-length columns it dropped', async () => {
    const long = { ...RELEASE, label: 'x'.repeat(300) };

    expect((await probeAlbum(candidate(), fetcher({ ok: true, value: long }))).tooLong).toEqual(['label']);
  });

  it('counts an over-length value only for a column the row is missing, since only those would be written', async () => {
    const long = { ...RELEASE, label: 'x'.repeat(300) };

    const album = await probeAlbum(candidate({ missing: ['tracklist'] }), fetcher({ ok: true, value: long }));

    expect(album.tooLong).toEqual([]);
  });
});

describe('probeAlbum and the release pin', () => {
  const pinned = (discogs_release_id: number) => ({
    ok: true as const,
    pin: { discogs_release_id, source: 'alex-2026-10', in_cache: true, tracks: [] },
  });

  it.each([
    ['a pin naming another release', pinned(530321), 'pin_disagrees'],
    ['an unanswered pins call', { ok: false as const, status: 502 }, 'pin_unanswered'],
  ])('settles on %s without fetching the release', async (_label, pin, outcome) => {
    const lml = fetcher({ ok: true, value: RELEASE });

    const album = await probeAlbum(candidate(), lml, pin);

    expect(album.outcome).toBe(outcome);
    expect(album.wouldFill).toEqual([]);
    expect(lml.release).not.toHaveBeenCalled();
    expect(lml.artist).not.toHaveBeenCalled();
  });

  it.each([
    ['no pin was asked for', undefined],
    ['no pin exists', { ok: true as const, pin: null }],
    ['the pin names the stored release', pinned(1442)],
  ])('proceeds to the release when %s', async (_label, pin) => {
    const lml = fetcher({ ok: true, value: RELEASE });

    expect((await probeAlbum(candidate(), lml, pin)).outcome).toBe('would_fill');
    expect(lml.release).toHaveBeenCalledWith(1442);
  });
});

describe('the probe tally', () => {
  it('sums outcomes, columns, the gate, cache hits, too_long and the Wikipedia share of token fills', async () => {
    let totals = emptyProbeTotals();
    const albums = [
      await probeAlbum(candidate({ has_wikipedia_url: true }), fetcher({ ok: true, value: RELEASE, latencyMs: 5 })),
      await probeAlbum(
        candidate({ album_id: 2 }),
        fetcher({
          ok: true,
          value: { ...RELEASE, cached: false, artist_id: 194, label: 'x'.repeat(300) },
          latencyMs: 900,
        })
      ),
      await probeAlbum(candidate({ album_id: 3 }), fetcher({ ok: false, status: 404 })),
      await probeAlbum(candidate({ album_id: 4 }), fetcher({ ok: true, value: RELEASE }, { ok: false, status: 504 })),
    ];
    for (const album of albums) {
      totals = addProbeAlbum(totals, album);
    }

    const summary = summarizeProbe(totals);

    expect(summary).toMatchObject({
      albums: 4,
      outcomes: { would_fill: 3, release_not_found_suspected: 1 },
      gate: { single: 2, various: 1 },
      would_fill_by_column: { tracklist: 3, label: 2, discogs_artist_id: 2, artist_image_url: 1, bio_tokens: 1 },
      too_long: { label: 1, full_release_date: 0, artist_image_url: 0 },
      artist: { answered: 1, not_found: 0, unanswered: 1 },
      release_cache: { hits: 2, misses: 1, hit_share: 2 / 3, miss_latency_ms: { p50: 900, p95: 900, max: 900 } },
      bio_tokens_fillable: 1,
      bio_tokens_fillable_with_wikipedia_url: 1,
    });
  });
});
