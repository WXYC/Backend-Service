/**
 * Unit tests for flowsheet-metadata-backfill enrich.ts.
 *
 * Pins the row-level UPDATE shape against three #639 contract guarantees:
 *   1. On LML success-with-match, all 10 metadata columns are written and
 *      `metadata_attempt_at = sql\`now()\`` is in the same .set() block.
 *   2. On LML success-no-match, the three search-URL columns are written
 *      and `metadata_attempt_at` is still stamped — no-match is still an
 *      attempt the recurring sweep should not retry.
 *   3. The .set() block calls `eq(flowsheet.id, row.id)` AND
 *      `isNull(flowsheet.metadata_attempt_at)` so a runtime stamp landing
 *      between the orchestrator's SELECT and this UPDATE wins.
 *
 * Also pins the spacer.gif filter (#638 implementation note 1) and the
 * Discogs bio cleanup mirroring metadata.service.ts.
 */
import { jest } from '@jest/globals';

import { db, flowsheet } from '@wxyc/database';
import {
  applyEnrichment,
  cleanDiscogsBio,
  extractArtwork,
  type EnrichRow,
} from '../../../../jobs/flowsheet-metadata-backfill/enrich';
import type { LmlLookupResponse } from '../../../../jobs/flowsheet-metadata-backfill/lml-types';

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock; returning: jest.Mock };
};

const baseRow: EnrichRow = {
  id: 42,
  artist_name: 'Autechre',
  album_title: 'Confield',
  track_title: 'VI Scose Poise',
};

const matchedResponse: LmlLookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: {
        release_id: 12345,
        release_url: 'https://www.discogs.com/release/12345',
        artwork_url: 'https://i.discogs.com/art.jpg',
        release_year: 2001,
        artist_bio: '[a=Rob Brown] and [a=Sean Booth] are Autechre.',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Autechre',
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/album/xyz',
        youtube_music_url: 'https://music.youtube.com/album/aaa',
        bandcamp_url: null,
        soundcloud_url: null,
      },
    },
  ],
  search_type: 'direct',
  song_not_found: false,
};

const noMatchResponse: LmlLookupResponse = {
  results: [],
  search_type: 'none',
  song_not_found: true,
};

const noArtworkResponse: LmlLookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: null }],
  search_type: 'direct',
};

describe('applyEnrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to "1 row updated" so existing match/no-match assertions
    // exercise the non-raced path. Tests that pin the race detector
    // override with `.mockResolvedValueOnce([])`.
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  it('writes 10 metadata columns and stamps metadata_attempt_at on LML success-with-match', async () => {
    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match');
    expect(mockDb.update).toHaveBeenCalledWith(flowsheet);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs).toMatchObject({
      artwork_url: 'https://i.discogs.com/art.jpg',
      discogs_url: 'https://www.discogs.com/release/12345',
      release_year: 2001,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/xyz',
      youtube_music_url: 'https://music.youtube.com/album/aaa',
      // bandcamp_url / soundcloud_url were null on the LML response → fall
      // back to the synthesized search URLs (mirrors metadata.service.ts).
    });
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    // Bio is cleaned of Discogs markup tags
    expect(setArgs.artist_bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(setArgs.artist_wikipedia_url).toBe('https://en.wikipedia.org/wiki/Autechre');
    // The stamp is the canonical sql`now()` chunk, not a JS Date
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
  });

  it('writes only synthesized search URLs and stamps on LML success-no-match (empty results)', async () => {
    const outcome = await applyEnrichment(baseRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match');

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.youtube_music_url).toContain('music.youtube.com/search');
    expect(setArgs.bandcamp_url).toContain('bandcamp.com/search');
    expect(setArgs.soundcloud_url).toContain('soundcloud.com/search');
    expect(renderSql(setArgs.metadata_attempt_at)).toMatch(/now\(\)/i);
    // The 7 metadata columns should NOT be set on no-match (so they remain
    // NULL in the DB) — the runtime path produces the same shape.
    expect('artwork_url' in setArgs).toBe(false);
    expect('discogs_url' in setArgs).toBe(false);
    expect('release_year' in setArgs).toBe(false);
    expect('spotify_url' in setArgs).toBe(false);
    expect('apple_music_url' in setArgs).toBe(false);
    expect('artist_bio' in setArgs).toBe(false);
    expect('artist_wikipedia_url' in setArgs).toBe(false);
  });

  it('treats artwork: null the same as no-match', async () => {
    const outcome = await applyEnrichment(baseRow, noArtworkResponse);
    expect(outcome).toBe('enriched_no_match');
  });

  it('strips Discogs spacer.gif placeholder from artwork_url (#638 note 1, until #649 lands)', async () => {
    const spacerResponse: LmlLookupResponse = {
      ...matchedResponse,
      results: [
        {
          library_item: { id: 1 },
          artwork: {
            ...matchedResponse.results[0].artwork,
            artwork_url: 'https://s.discogs.com/images/spacer.gif',
          },
        },
      ],
    };

    const outcome = await applyEnrichment(baseRow, spacerResponse);
    expect(outcome).toBe('enriched_match');
    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs.artwork_url).toBeNull();
  });

  it('idempotency guard: WHERE narrows by id AND metadata_attempt_at IS NULL', async () => {
    // The WHERE makes the UPDATE a no-op against rows the runtime path
    // already stamped. Verify .where() was called once with a single
    // drizzle expression whose rendered SQL references both columns.
    await applyEnrichment(baseRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const rendered = renderSql(whereArg);
    expect(rendered).toMatch(/id/);
    expect(rendered.toLowerCase()).toMatch(/metadata_attempt_at/);
  });

  it('returns enriched_match_raced when 0 rows update (runtime path stamped first)', async () => {
    // Race scenario: between the orchestrator's SELECT and this UPDATE,
    // the runtime path landed its own stamp on the same row, so
    // `metadata_attempt_at IS NULL` no longer matches and Postgres
    // updates 0 rows. The data outcome is identical (both writers
    // produce the same payload) — only the metric splits.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match_raced');
  });

  it('returns enriched_no_match_raced when 0 rows update on the no-match path', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(baseRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match_raced');
  });
});

describe('cleanDiscogsBio', () => {
  // Direct unit tests — `applyEnrichment` exercises this through
  // `artist_bio` end-to-end, but pinning each markup form individually
  // catches a regression that breaks one bracket form silently.
  it('strips [a=Name] artist references', () => {
    expect(cleanDiscogsBio('[a=Aphex Twin] is great')).toBe('Aphex Twin is great');
  });

  it('strips [l=Label] label references', () => {
    expect(cleanDiscogsBio('Released on [l=Warp Records]')).toBe('Released on Warp Records');
  });

  it('strips [r=Release] release references', () => {
    expect(cleanDiscogsBio('See [r=12345] for the release')).toBe('See 12345 for the release');
  });

  it('strips [m=Master] master references', () => {
    expect(cleanDiscogsBio('Master entry [m=98765]')).toBe('Master entry 98765');
  });

  it('strips [url=...]label[/url] link markup, keeping the label text', () => {
    expect(cleanDiscogsBio('Visit [url=https://example.com]their site[/url] for more')).toBe(
      'Visit their site for more'
    );
  });

  it('handles a bio with multiple markup forms in one pass', () => {
    const raw = '[a=Rob Brown] and [a=Sean Booth] are Autechre, on [l=Warp Records].';
    expect(cleanDiscogsBio(raw)).toBe('Rob Brown and Sean Booth are Autechre, on Warp Records.');
  });

  it('returns plain text unchanged', () => {
    expect(cleanDiscogsBio('No markup here')).toBe('No markup here');
  });

  it('returns empty string unchanged', () => {
    expect(cleanDiscogsBio('')).toBe('');
  });
});

describe('extractArtwork', () => {
  it('returns null when results is empty', () => {
    expect(extractArtwork({ results: [], search_type: 'none' })).toBeNull();
  });

  it('returns null when results[0].artwork is missing', () => {
    expect(
      extractArtwork({
        results: [{ library_item: { id: 1 } }],
        search_type: 'direct',
      })
    ).toBeNull();
  });

  it('returns null when results[0].artwork is explicitly null', () => {
    expect(
      extractArtwork({
        results: [{ library_item: { id: 1 }, artwork: null }],
        search_type: 'direct',
      })
    ).toBeNull();
  });

  it('returns the first result’s artwork object on success-with-match', () => {
    const got = extractArtwork(matchedResponse);
    expect(got?.release_id).toBe(12345);
  });
});
