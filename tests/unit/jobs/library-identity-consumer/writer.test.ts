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

jest.mock('../../../../jobs/library-identity-consumer/logger', () => ({
  initLogger: jest.fn(),
  closeLogger: jest.fn(),
  log: jest.fn(),
  captureError: jest.fn(),
}));
import { log } from '../../../../jobs/library-identity-consumer/logger';

import type { BulkResolveResult, BulkResolveTrackEntry } from '../../../../jobs/library-identity-consumer/lml-types';
import {
  projectMainRow,
  writeSingleArtist,
  stampUnresolvedAttemptedAt,
  writeCompilationTracks,
} from '../../../../jobs/library-identity-consumer/writer';

type SqlChunk = { value?: string | string[]; queryChunks?: SqlChunk[]; raw?: string };
type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<string | SqlChunk>;
  raw?: string;
  // The manual drizzle mock's `sql.join` shape (tests/__mocks__/drizzle-orm.ts)
  // — same handling as flowsheet-ghost-row-sweep's renderer.
  join?: unknown[];
  sep?: unknown;
};
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as SqlChunk & SqlLike;
    if (typeof o.raw === 'string') return o.raw;
    if (Array.isArray(o.queryChunks) || Array.isArray(o.sql) || Array.isArray(o.join)) return renderSql(o);
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
  if (Array.isArray(obj.join)) return obj.join.map(renderSql).join(renderSql(obj.sep));
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

describe('stampUnresolvedAttemptedAt (BS#974)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([]);
  });

  it('issues one UPDATE binding the ids as a single ANY(::int[]) array literal', async () => {
    await stampUnresolvedAttemptedAt([1, 2, 3]);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    const rendered = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(rendered).toMatch(/UPDATE[\s\S]*library\b/i);
    expect(rendered).toMatch(/unresolved_attempted_at/);
    expect(rendered).toMatch(/NOW\(\)/);
    // Array-literal bind (BS#1071/#1072), not an IN (...) positional splat.
    expect(rendered).toMatch(/ANY\(/);
    expect(rendered).toMatch(/\{1,2,3\}/);
    expect(rendered).toMatch(/::int\[\]/);
  });

  it('is a no-op (no query) for an empty id list', async () => {
    await stampUnresolvedAttemptedAt([]);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('writeCompilationTracks (BS#1991 / #801 S2)', () => {
  const track = (overrides: Partial<BulkResolveTrackEntry> = {}): BulkResolveTrackEntry => ({
    artist_name: 'Juana Molina',
    track_title: 'la paradoja',
    track_position: null,
    resolved_artist_name: 'Juana Molina',
    confidence: 0.9,
    ...overrides,
  });

  const compilation = (
    overrides: Partial<Extract<BulkResolveResult, { kind: 'compilation' }>> = {}
  ): Extract<BulkResolveResult, { kind: 'compilation' }> => ({
    kind: 'compilation',
    library_id: 200,
    provenance: [],
    tracks_attempted: true,
    tracks: [track()],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is a no-op (no query) for an empty results array', async () => {
    const outcome = await writeCompilationTracks([]);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
    expect(outcome.rows_written).toBe(0);
  });

  it("fetches the page's compilation_track_artist rows in ONE query keyed by library_id", async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([]) // CTA fetch
      .mockResolvedValue([]); // artist resolution — with zero CTA matches it doesn't fire at all, so no Once (it would leak into the next test's queue)

    await writeCompilationTracks([compilation({ library_id: 200 }), compilation({ library_id: 201 })]);

    const ctaFetchCalls = (db.execute as jest.Mock).mock.calls.filter((c) =>
      /SELECT[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(ctaFetchCalls.length).toBe(1);
    expect(renderSql(ctaFetchCalls[0][0])).toMatch(/ANY\(/);
  });

  it('skips a "miss" entry (resolved_artist_name null) — no write, not counted as a CTA-match failure', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      {
        id: 1,
        library_id: 200,
        artist_name: 'Juana Molina',
        track_title: 'la paradoja',
        track_position: null,
        track_artist_link_method: null,
      },
    ]);

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ resolved_artist_name: null })] })]);

    const updateCalls = (db.execute as jest.Mock).mock.calls.filter((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(updateCalls.length).toBe(0);
    expect(outcome.rows_written).toBe(0);
    expect(outcome.rows_skipped_no_cta_match).toBe(0);
  });

  it('never overwrites a CTA row whose track_artist_link_method is already "librarian"', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      {
        id: 1,
        library_id: 200,
        artist_name: 'Juana Molina',
        track_title: 'la paradoja',
        track_position: null,
        track_artist_link_method: 'librarian',
      },
    ]);

    const outcome = await writeCompilationTracks([compilation()]);

    const updateCalls = (db.execute as jest.Mock).mock.calls.filter((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(updateCalls.length).toBe(0);
    expect(outcome.rows_skipped_librarian).toBe(1);
  });

  it('skips a track entry whose (artist_name, track_title) echo matches no CTA row', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]); // no CTA rows at all

    const outcome = await writeCompilationTracks([compilation()]);

    expect(outcome.rows_skipped_no_cta_match).toBe(1);
    expect(outcome.rows_written).toBe(0);
  });

  it('resolves resolved_artist_name -> artists.id via a batched fold_artist_name join and UPSERTs the identity onto the matched CTA row', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: null,
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([{ id: 42 }]); // batched UPDATE's RETURNING — rows the guard let through

    const outcome = await writeCompilationTracks([compilation()]);

    const artistResolveCall = (db.execute as jest.Mock).mock.calls.find(
      (c) => /fold_artist_name/i.test(renderSql(c[0])) && /VALUES/i.test(renderSql(c[0]))
    );
    expect(artistResolveCall).toBeDefined();

    const updateCall = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(updateCall).toBeDefined();
    const sqlText = renderSql(updateCall?.[0]);
    expect(sqlText).toContain('42');
    expect(sqlText).toContain('7');
    expect(sqlText).toMatch(/lml_backfill/);
    expect(sqlText).toMatch(/IS DISTINCT FROM/);
    expect(outcome.rows_written).toBe(1);
    expect(outcome.rows_skipped_no_catalog_artist).toBe(0);
  });

  it('writes a NULL track_artist_id (not an error) when resolved_artist_name matches nothing in the catalog', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: null,
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([]) // zero artist matches
      .mockResolvedValueOnce([{ id: 42 }]); // RETURNING: the NULL-artist write still lands

    const outcome = await writeCompilationTracks([
      compilation({ tracks: [track({ resolved_artist_name: 'Nobody In Catalog' })] }),
    ]);

    expect(outcome.rows_skipped_no_catalog_artist).toBe(1);
    expect(outcome.rows_written).toBe(1);
  });

  it('treats 2+ matching artists rows under the fold as ambiguous (null, not an arbitrary pick)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: null,
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([
        { input_name: 'Juana Molina', artist_id: 7 },
        { input_name: 'Juana Molina', artist_id: 8 },
      ])
      .mockResolvedValueOnce([]);

    const outcome = await writeCompilationTracks([compilation()]);

    expect(outcome.rows_skipped_no_catalog_artist).toBe(1);
  });

  it('position rider: writes track_position verbatim when the CTA row has none and exactly one position is offered', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: null,
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([{ id: 42 }]); // RETURNING — position_rows_written derives from landed rows

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ track_position: 'A1' })] })]);

    const updateCall = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(renderSql(updateCall?.[0])).toContain('A1');
    expect(outcome.position_rows_written).toBe(1);
  });

  it('position rider: skips the position write (but not the identity write) when two entries at the same key offer different positions', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Various Artists',
          track_title: null,
          track_position: null,
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([{ input_name: 'Some Artist', artist_id: 9 }])
      .mockResolvedValueOnce([{ id: 42 }]); // RETURNING: identity write unaffected by position ambiguity

    const outcome = await writeCompilationTracks([
      compilation({
        tracks: [
          track({
            artist_name: 'Various Artists',
            track_title: null,
            track_position: 'A1',
            resolved_artist_name: 'Some Artist',
          }),
          track({
            artist_name: 'Various Artists',
            track_title: null,
            track_position: 'B3',
            resolved_artist_name: 'Some Artist',
          }),
        ],
      }),
    ]);

    expect(outcome.position_rows_skipped_ambiguous).toBe(1);
    expect(outcome.position_rows_written).toBe(0);
    // The identity write itself is unaffected by position ambiguity.
    const updateCall = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(updateCall).toBeDefined();
    expect(outcome.rows_written).toBe(1);
  });

  it('does not overwrite an existing non-null track_position (position rider only fires when CTA has none)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 42,
          library_id: 200,
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: 'A1',
          track_artist_link_method: null,
        },
      ])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([]);

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ track_position: 'B9' })] })]);

    expect(outcome.position_rows_written).toBe(0);
    const updateCall = (db.execute as jest.Mock).mock.calls.find((c) =>
      /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0]))
    );
    expect(renderSql(updateCall?.[0])).not.toContain('B9');
  });
});

describe('writeCompilationTracks — review-gate fixes (BS#1991 bounce 1)', () => {
  const track = (overrides: Partial<BulkResolveTrackEntry> = {}): BulkResolveTrackEntry => ({
    artist_name: 'Juana Molina',
    track_title: 'la paradoja',
    track_position: null,
    resolved_artist_name: 'Juana Molina',
    confidence: 0.93,
    ...overrides,
  });
  const compilation = (
    overrides: Partial<Extract<BulkResolveResult, { kind: 'compilation' }>> = {}
  ): Extract<BulkResolveResult, { kind: 'compilation' }> => ({
    kind: 'compilation',
    library_id: 200,
    provenance: [],
    tracks_attempted: true,
    tracks: [track()],
    ...overrides,
  });
  const ctaRow = (overrides: Record<string, unknown> = {}) => ({
    id: 42,
    library_id: 200,
    artist_name: 'Juana Molina',
    track_title: 'la paradoja',
    track_position: null,
    track_artist_link_method: null,
    track_artist_id: null,
    track_artist_link_confidence: null,
    ...overrides,
  });
  const updateCalls = () =>
    (db.execute as jest.Mock).mock.calls.filter((c) => /UPDATE[\s\S]*compilation_track_artist/i.test(renderSql(c[0])));
  const foldCalls = () => (db.execute as jest.Mock).mock.calls.filter((c) => /fold_artist_name/i.test(renderSql(c[0])));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues NO UPDATE statement when every matched row is already unchanged — the watermark trigger is FOR EACH STATEMENT and fires even on UPDATE 0', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        ctaRow({
          track_position: 'A1',
          track_artist_link_method: 'lml_backfill',
          track_artist_id: 7,
          track_artist_link_confidence: 0.93,
        }),
      ])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }]);

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ track_position: 'A1' })] })]);

    expect(updateCalls().length).toBe(0);
    expect(outcome.rows_written).toBe(0);
    expect(outcome.rows_skipped_unchanged).toBe(1);
  });

  it('treats a float4-quantized stored confidence as unchanged against the float8 wire value', async () => {
    // 0.2 stored as Postgres `real` surfaces as 0.20000000298023224 through a
    // float8 lens; Math.fround maps both to the same float32.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        ctaRow({
          track_artist_link_method: 'lml_backfill',
          track_artist_id: 7,
          track_artist_link_confidence: 0.20000000298023224,
        }),
      ])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }]);

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ confidence: 0.2 })] })]);

    expect(updateCalls().length).toBe(0);
    expect(outcome.rows_skipped_unchanged).toBe(1);
  });

  it('nulls (and warns on) a track_position longer than varchar(20) instead of aborting the whole chunk', async () => {
    const longPosition = 'A'.repeat(25);
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([ctaRow()])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([{ id: 42 }]);

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ track_position: longPosition })] })]);

    const update = updateCalls();
    expect(update.length).toBe(1);
    expect(renderSql(update[0][0])).not.toContain(longPosition);
    expect(outcome.rows_written).toBe(1);
    expect(outcome.position_rows_written).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'compilation_position_too_long',
      expect.any(String),
      expect.objectContaining({ cta_id: 42 })
    );
  });

  it('resolves only the names of entries that matched a CTA row and survived librarian precedence', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        ctaRow(),
        ctaRow({
          id: 43,
          artist_name: 'Kept By Librarian',
          track_title: 'Locked',
          track_artist_link_method: 'librarian',
        }),
      ])
      .mockResolvedValue([]);

    await writeCompilationTracks([
      compilation({
        tracks: [
          track(),
          track({ artist_name: 'Ghost', track_title: 'No CTA Row', resolved_artist_name: 'Ghost Resolved' }),
          track({ artist_name: 'Kept By Librarian', track_title: 'Locked', resolved_artist_name: 'Lib Resolved' }),
        ],
      }),
    ]);

    const fold = foldCalls();
    expect(fold.length).toBe(1);
    const sqlText = renderSql(fold[0][0]);
    expect(sqlText).toContain('Juana Molina');
    expect(sqlText).not.toContain('Ghost Resolved');
    expect(sqlText).not.toContain('Lib Resolved');
  });

  it('chunks the artist-name resolution VALUES list (bind-parameter budget), not just the UPDATE', async () => {
    const n = 1001;
    const rows = Array.from({ length: n }, (_, i) =>
      ctaRow({ id: i + 1, artist_name: `Artist ${i}`, track_title: `T${i}` })
    );
    const tracks = Array.from({ length: n }, (_, i) =>
      track({ artist_name: `Artist ${i}`, track_title: `T${i}`, resolved_artist_name: `Resolved ${i}` })
    );
    (db.execute as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValue([]);

    await writeCompilationTracks([compilation({ tracks })]);

    expect(foldCalls().length).toBe(2);
  });

  it('derives position_rows_written from RETURNING, not from queue time', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([ctaRow()])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([]); // guard filtered the row server-side: nothing RETURNING

    const outcome = await writeCompilationTracks([compilation({ tracks: [track({ track_position: 'A1' })] })]);

    expect(outcome.rows_written).toBe(0);
    expect(outcome.position_rows_written).toBe(0);
  });

  it('warns on a page-level CTA echo-match gap (systematic join-back divergence must not be silent)', async () => {
    const tracks = Array.from({ length: 12 }, (_, i) =>
      track({ artist_name: `Ghost ${i}`, track_title: `G${i}`, resolved_artist_name: `R${i}` })
    );
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValue([]);

    const outcome = await writeCompilationTracks([compilation({ tracks })]);

    expect(outcome.rows_skipped_no_cta_match).toBe(12);
    expect(log).toHaveBeenCalledWith(
      'warn',
      'compilation_cta_match_gap',
      expect.any(String),
      expect.objectContaining({ rows_skipped_no_cta_match: 12 })
    );
  });

  it('does not fire the echo-gap warn for an isolated miss', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([ctaRow()])
      .mockResolvedValueOnce([{ input_name: 'Juana Molina', artist_id: 7 }])
      .mockResolvedValueOnce([{ id: 42 }]);

    await writeCompilationTracks([
      compilation({
        tracks: [track(), track({ artist_name: 'Ghost', track_title: 'X', resolved_artist_name: 'R' })],
      }),
    ]);

    const gapWarns = (log as jest.Mock).mock.calls.filter((c) => c[1] === 'compilation_cta_match_gap');
    expect(gapWarns.length).toBe(0);
  });
});
