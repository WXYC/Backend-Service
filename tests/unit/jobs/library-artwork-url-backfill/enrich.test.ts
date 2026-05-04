/**
 * Unit tests for library-artwork-url-backfill enrich.ts.
 *
 * Pins the row-level UPDATE shape against #637's contract:
 *   1. On LML success-with-match (artwork URL present, not a spacer.gif),
 *      the .set() block writes only `artwork_url` — single-column UPDATE.
 *   2. On LML success-no-match (empty results, missing artwork field, null
 *      artwork, or a URL that filters down to null after spacer-stripping),
 *      no UPDATE is issued — the row stays NULL so a future sweep retries.
 *   3. The .where() narrows by id AND `artwork_url IS NULL` so a runtime
 *      stamp landing between the orchestrator's SELECT and this UPDATE wins.
 *   4. The race detector returns `enriched_match_raced` when 0 rows update.
 *
 * Also pins the spacer.gif filter (mirrors flowsheet-metadata-backfill until
 * #649's shared helper lands).
 */
import { jest } from '@jest/globals';

import { db, library } from '@wxyc/database';
import {
  applyEnrichment,
  extractArtwork,
  type EnrichRow,
} from '../../../../jobs/library-artwork-url-backfill/enrich';
import type { LmlLookupResponse } from '../../../../jobs/library-artwork-url-backfill/lml-types';

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
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
};

const matchedResponse: LmlLookupResponse = {
  results: [
    {
      library_item: { id: 1 },
      artwork: { artwork_url: 'https://i.discogs.com/art.jpg' },
    },
  ],
  search_type: 'direct',
};

const noMatchResponse: LmlLookupResponse = {
  results: [],
  search_type: 'none',
};

const noArtworkResponse: LmlLookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: null }],
  search_type: 'direct',
};

const nullArtworkUrlResponse: LmlLookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { artwork_url: null } }],
  search_type: 'direct',
};

describe('applyEnrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to "1 row updated" so existing match assertions exercise the
    // non-raced path. Tests that pin the race detector override with
    // `.mockResolvedValueOnce([])`.
    mockDb._chain.returning.mockResolvedValue([{ id: baseRow.id }]);
  });

  it('writes only artwork_url on LML success-with-match (single-column UPDATE)', async () => {
    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match');
    expect(mockDb.update).toHaveBeenCalledWith(library);

    const setArgs = mockDb._chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(setArgs)).toEqual(['artwork_url']);
    expect(setArgs.artwork_url).toBe('https://i.discogs.com/art.jpg');
  });

  it('does NOT issue an UPDATE on LML success-no-match (empty results)', async () => {
    const outcome = await applyEnrichment(baseRow, noMatchResponse);
    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('treats artwork: null the same as no-match (no UPDATE)', async () => {
    const outcome = await applyEnrichment(baseRow, noArtworkResponse);
    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('treats artwork_url: null the same as no-match (no UPDATE)', async () => {
    const outcome = await applyEnrichment(baseRow, nullArtworkUrlResponse);
    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('strips Discogs spacer.gif placeholder, treating the row as no-match', async () => {
    // A spacer.gif URL would otherwise persist as a non-null but useless
    // artwork_url, defeating the search-path short-circuit. The filter drops
    // it; after that, the row has no artwork to write, so the outcome is
    // no-match (no UPDATE).
    const spacerResponse: LmlLookupResponse = {
      results: [
        {
          library_item: { id: 1 },
          artwork: { artwork_url: 'https://s.discogs.com/images/spacer.gif' },
        },
      ],
      search_type: 'direct',
    };

    const outcome = await applyEnrichment(baseRow, spacerResponse);
    expect(outcome).toBe('enriched_no_match');
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('idempotency guard: WHERE narrows by id AND artwork_url IS NULL', async () => {
    // The WHERE makes the UPDATE a no-op against rows the search-path runtime
    // already stamped. Verify .where() was called once with a single drizzle
    // expression whose rendered SQL references both columns.
    await applyEnrichment(baseRow, matchedResponse);
    expect(mockDb._chain.where).toHaveBeenCalledTimes(1);
    const whereArg = mockDb._chain.where.mock.calls[0]?.[0];
    const rendered = renderSql(whereArg);
    expect(rendered).toMatch(/id/);
    expect(rendered.toLowerCase()).toMatch(/artwork_url/);
  });

  it('returns enriched_match_raced when 0 rows update (search-path stamped first)', async () => {
    // Race scenario: between the orchestrator's SELECT and this UPDATE, the
    // search-path enrichment landed its own stamp on the same row, so
    // `artwork_url IS NULL` no longer matches and Postgres updates 0 rows.
    // The data outcome is identical (both writers produce the same URL —
    // both source it from LML / discogs-cache.release.artwork_url). Only the
    // metric splits.
    mockDb._chain.returning.mockResolvedValueOnce([]);

    const outcome = await applyEnrichment(baseRow, matchedResponse);
    expect(outcome).toBe('enriched_match_raced');
  });
});

describe('extractArtwork', () => {
  // Direct unit tests — `applyEnrichment` exercises this end-to-end, but
  // pinning each shape individually catches a regression that breaks one
  // case silently.
  it('returns the artwork from results[0]', () => {
    expect(extractArtwork(matchedResponse)?.artwork_url).toBe('https://i.discogs.com/art.jpg');
  });

  it('returns null on empty results', () => {
    expect(extractArtwork(noMatchResponse)).toBeNull();
  });

  it('returns null when results[0] has no artwork field', () => {
    const response: LmlLookupResponse = {
      results: [{ library_item: { id: 1 } }],
      search_type: 'direct',
    };
    expect(extractArtwork(response)).toBeNull();
  });

  it('returns null when results[0].artwork is explicitly null', () => {
    expect(extractArtwork(noArtworkResponse)).toBeNull();
  });
});
