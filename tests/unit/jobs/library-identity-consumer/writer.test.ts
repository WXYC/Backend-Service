/**
 * Unit tests for writer.ts — projects a `BulkResolveResult` into the dual-
 * table write set.
 *
 * Contract:
 *   - Opens a db.transaction().
 *   - SELECT … FOR UPDATE on the existing main row (defense-in-depth).
 *   - Per-source rows: one INSERT per provenance entry whose confidence is
 *     non-null. Null-confidence entries are skipped (substrate check
 *     constraint).
 *   - Main row: ON CONFLICT (library_id) DO UPDATE; columns projected from
 *     `ReconciledIdentity` per the file header's mapping (release/recording
 *     columns NULL until LML surfaces them; artist-id columns without main-
 *     row destinations dropped from the main row but carried by provenance).
 *   - Per-source upserts run before the main row upsert.
 */
import { db } from '@wxyc/database';

import type { BulkResolveResult } from '../../../../jobs/library-identity-consumer/lml-types';
import { projectMainRow, writeSingleArtist } from '../../../../jobs/library-identity-consumer/writer';

type SqlChunk = { value?: string | string[]; queryChunks?: SqlChunk[]; raw?: string };
type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<string | SqlChunk>;
  raw?: string;
};
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as SqlChunk & SqlLike;
    if (typeof o.raw === 'string') return o.raw;
    if (Array.isArray(o.queryChunks) || Array.isArray(o.sql)) return renderSql(o);
    if (Array.isArray(o.value)) return o.value.join('');
    if (typeof o.value === 'string') return o.value;
  }
  return '';
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) {
    let out = '';
    const fragments = obj.sql;
    const values = obj.values ?? [];
    for (let i = 0; i < fragments.length; i++) {
      out += fragments[i];
      if (i < values.length) out += renderValue(values[i]);
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.queryChunks)) return renderSql(chunk);
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

const singleArtist = (
  overrides: Partial<Extract<BulkResolveResult, { kind: 'single_artist' }>> = {}
): Extract<BulkResolveResult, { kind: 'single_artist' }> => ({
  kind: 'single_artist',
  library_id: 100,
  main: {
    discogs_artist_id: 12345,
    musicbrainz_artist_id: 'mb-1',
    wikidata_qid: 'Q-1',
    spotify_artist_id: 'sp-1',
    apple_music_artist_id: 'am-1',
    bandcamp_id: 'bc-1',
  },
  method: 'cross_source_agreement',
  confidence: 0.95,
  provenance: [
    { source: 'discogs', method: 'exact_match', confidence: 1.0, external_id: 'D-1' },
    { source: 'wikidata', method: 'cross_source_agreement', confidence: 0.9, external_id: 'Q-1' },
  ],
  ...overrides,
});

describe('projectMainRow', () => {
  it('maps artist-level wikidata/spotify/apple_music to their main-row columns', () => {
    const main = projectMainRow({
      wikidata_qid: 'Q-1',
      spotify_artist_id: 'sp-1',
      apple_music_artist_id: 'am-1',
    });
    expect(main.wikidata_qid).toBe('Q-1');
    expect(main.spotify_id).toBe('sp-1');
    expect(main.apple_music_id).toBe('am-1');
  });

  it('leaves release/recording columns NULL (not in the LML contract today)', () => {
    const main = projectMainRow({ wikidata_qid: 'Q-1' });
    expect(main.discogs_master_id).toBeNull();
    expect(main.discogs_release_id).toBeNull();
    expect(main.musicbrainz_release_group_mbid).toBeNull();
    expect(main.musicbrainz_release_mbid).toBeNull();
    expect(main.musicbrainz_recording_mbid).toBeNull();
  });

  it('drops artist-only IDs without main-row destinations (discogs_artist_id, musicbrainz_artist_id, bandcamp_id)', () => {
    // This is the documented gap — those values are written to
    // library_identity_source.external_id via provenance rows, but the
    // main row has no column for them yet.
    const main = projectMainRow({
      discogs_artist_id: 12345,
      musicbrainz_artist_id: 'mb-1',
      bandcamp_id: 'bc-1',
    });
    expect(main).not.toHaveProperty('discogs_artist_id');
    expect(main).not.toHaveProperty('musicbrainz_artist_id');
    expect(main).not.toHaveProperty('bandcamp_id');
  });
});

describe('writeSingleArtist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([]);
  });

  it('opens a transaction', async () => {
    await writeSingleArtist(singleArtist());
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
  });

  it('issues SELECT … FOR UPDATE on library_identity for the target library_id', async () => {
    await writeSingleArtist(singleArtist({ library_id: 42 }));
    const call = findCallMatching(/SELECT[\s\S]*library_identity[\s\S]*FOR UPDATE/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toContain('42');
  });

  it('UPSERTs one row per provenance entry into library_identity_source with ON CONFLICT', async () => {
    await writeSingleArtist(singleArtist());
    const sourceUpserts = (db.execute as jest.Mock).mock.calls.filter((c) =>
      /INSERT INTO[\s\S]*library_identity_source/i.test(renderSql(c[0]))
    );
    expect(sourceUpserts.length).toBe(2);
    sourceUpserts.forEach((call) => {
      expect(renderSql(call[0])).toMatch(/ON CONFLICT/i);
    });
  });

  it('skips provenance rows whose confidence is null (substrate check-constraint)', async () => {
    const result = singleArtist({
      provenance: [
        { source: 'discogs', method: 'exact_match', confidence: 1.0, external_id: 'D-1' },
        // null-confidence rows are emitted when external_id is null too;
        // the substrate forbids null confidence so we have to skip.
        { source: 'wikidata', method: 'cross_source_agreement', confidence: null, external_id: null },
      ],
    });
    const outcome = await writeSingleArtist(result);
    const sourceUpserts = (db.execute as jest.Mock).mock.calls.filter((c) =>
      /INSERT INTO[\s\S]*library_identity_source/i.test(renderSql(c[0]))
    );
    expect(sourceUpserts.length).toBe(1);
    expect(outcome.source_rows_written).toBe(1);
    expect(outcome.source_rows_skipped_null_confidence).toBe(1);
  });

  it('UPSERTs the main row into library_identity with ON CONFLICT (library_id) DO UPDATE', async () => {
    await writeSingleArtist(singleArtist());
    const call = findCallMatching(/INSERT INTO[\s\S]*library_identity\b(?![_])/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ON CONFLICT\s*\(\s*"?library_id"?\s*\)\s*DO UPDATE/i);
  });

  it('issues per-source upserts before the main-row upsert (recompute order)', async () => {
    await writeSingleArtist(singleArtist());
    const calls = (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c[0]));
    const sourceUpsertIdx = calls.findIndex((s) => /INSERT INTO[\s\S]*library_identity_source/i.test(s));
    const mainUpsertIdx = calls.findIndex((s) =>
      /INSERT INTO[\s\S]*library_identity\b(?![_])[\s\S]*ON CONFLICT\s*\(\s*"?library_id"?\s*\)/i.test(s)
    );
    expect(sourceUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(mainUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(sourceUpsertIdx).toBeLessThan(mainUpsertIdx);
  });

  it('stamps the writer marker `consumer:lml-bulk` in the notes columns', async () => {
    await writeSingleArtist(singleArtist());
    const calls = (db.execute as jest.Mock).mock.calls;
    const matchedAny = calls.some((c) => JSON.stringify(c[0]).includes('consumer:lml-bulk'));
    expect(matchedAny).toBe(true);
  });
});
