/**
 * Unit tests for the artist-search-alias-consumer orchestrator (BS#1266).
 *
 * Covers:
 *   - Counter shape: names_scanned / names_resolved / names_missing /
 *     fanout_writes / source_rows_written / lml_total_calls / lml_total_latency_ms.
 *   - DRY_RUN suppression: writer is never invoked; counters update;
 *     a single locked JSON object is emitted on stdout.
 *   - V/A filtering: `Various Artists`, `Soundtrack`, `V/A`, `Compilation`
 *     names are dropped before the LML call.
 *   - Cursor advancement on all-V/A batch: cursor advances by the batch
 *     tail, not by the (empty) eligible set, so the loop terminates.
 *   - Name-group fan-out: one name → multiple `artist_id` writes; the
 *     `fanout_writes` counter increments per artist_id beyond the first.
 *   - Reconcile semantics: `sources_present` from LML has
 *     `'wxyc_library_alt'` and `'wxyc_library_credit'` appended
 *     unconditionally.
 *   - BS#3554 credit split: each comma-joined alt value also yields one
 *     `wxyc_library_credit` row per name, next to the unchanged joined
 *     `wxyc_library_alt` row.
 *   - LML error: the entire batch is counted as `names_missing`; loop
 *     continues with the next batch; cursor still advances.
 */
import { runConsumer } from '../../../../jobs/artist-search-alias-consumer/orchestrate';
import type {
  ArtistSearchAliasesBulkResponse,
  ArtistSearchAliasesResult,
} from '../../../../jobs/artist-search-alias-consumer/lml-types';
import type { NameGroup } from '../../../../jobs/artist-search-alias-consumer/select';

type LoadNameGroupsFn = (cursor: string) => Promise<NameGroup[]>;
type FetchBulkFn = (names: string[]) => Promise<ArtistSearchAliasesBulkResponse>;
type FetchAltsFn = (artistIds: number[]) => Promise<Map<number, string[]>>;
type WriteFn = (
  artist_id: number,
  canonicalName: string,
  variants: unknown[],
  sourcesPresent: string[]
) => Promise<{ variants_written: number }>;

const makeLmlResult = (
  name: string,
  variantCount: number,
  sources_present: (
    'discogs_name_variation' | 'discogs_alias' | 'discogs_member' | 'wxyc_library_alt' | 'wxyc_library_credit'
  )[] = ['discogs_name_variation']
): ArtistSearchAliasesResult => ({
  name,
  variants: Array.from({ length: variantCount }, (_, i) => ({
    source: 'discogs_name_variation' as const,
    variant: `${name}-variant-${i}`,
    method: 'name_variation' as const,
    confidence: 0.95,
    related_artist_id: null,
    external_subject_id: null,
    external_object_id: null,
    active: null,
  })),
  sources_present,
});

describe('runConsumer — happy path', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches resolved → writer, missing → counter, with the right name-level totals', async () => {
    const batches: NameGroup[][] = [
      [
        { artist_name: 'Stereolab', artist_ids: [7] },
        { artist_name: 'Juana Molina', artist_ids: [42] },
        { artist_name: 'Nobody Knows', artist_ids: [9999] },
      ],
      [],
    ];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockImplementation(() => {
      const next = batches.shift();
      return Promise.resolve(next ?? []);
    });

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 2), makeLmlResult('Juana Molina', 1)],
      missing: ['Nobody Knows'],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest
      .fn<WriteFn>()
      .mockImplementation((_id, _canonicalName, variants) => Promise.resolve({ variants_written: variants.length }));

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    expect(fetchBulk).toHaveBeenCalledTimes(1);
    expect(fetchBulk.mock.calls[0][0]).toEqual(['Stereolab', 'Juana Molina', 'Nobody Knows']);
    // Writer is called for every eligible artist_id — including the
    // missing one (with variants=[] and sourcesPresent naming the two local
    // legs) so any stale wxyc_library_alt / wxyc_library_credit rows
    // reconcile away.
    expect(writeArtistVariants).toHaveBeenCalledTimes(3);

    // For the missing name, sourcesPresent must NOT include any Discogs
    // sources (the LML composer didn't run those legs for it).
    const missingCall = writeArtistVariants.mock.calls.find(
      (c) => (c as unknown as [number])[0] === 9999
    ) as unknown as [number, string, unknown[], string[]] | undefined;
    expect(missingCall).toBeDefined();
    // missingCall: [artist_id, canonicalName, variants, sourcesPresent]
    expect(missingCall?.[2]).toEqual([]);
    expect(missingCall?.[3]).toEqual(['wxyc_library_alt', 'wxyc_library_credit']);

    expect(result.totals.names_scanned).toBe(3);
    expect(result.totals.names_resolved).toBe(2);
    expect(result.totals.names_missing).toBe(1);
    expect(result.totals.fanout_writes).toBe(0);
    // 2 Stereolab variants + 1 Juana variant = 3 alias variants from LML.
    // Plus zero from wxyc_library_alt (empty Map).
    expect(result.totals.source_rows_written).toBe(3);
    expect(result.totals.lml_total_calls).toBe(1);
  });

  it('filters V/A names before the LML call; cursor advances by batch tail', async () => {
    const allVaBatch: NameGroup[] = [
      { artist_name: 'Various Artists', artist_ids: [100] },
      { artist_name: 'V/A', artist_ids: [101] },
      { artist_name: 'Soundtrack', artist_ids: [102] },
    ];
    const followupBatch: NameGroup[] = [{ artist_name: 'Stereolab', artist_ids: [7] }];

    // Cursor-aware mock: first call returns the V/A batch, second call
    // returns the followup batch (only if the cursor advanced past the V/A
    // tail). Third call returns empty.
    const calls: string[] = [];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockImplementation((cursor: string) => {
      calls.push(cursor);
      if (cursor === '') return Promise.resolve(allVaBatch);
      if (cursor === 'Soundtrack') return Promise.resolve(followupBatch);
      return Promise.resolve([]);
    });

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 1)],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 1 });

    await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    // The orchestrator must NOT have called LML with V/A names.
    expect(fetchBulk).toHaveBeenCalledTimes(1);
    expect(fetchBulk.mock.calls[0][0]).toEqual(['Stereolab']);
    // The cursor advanced past 'Soundtrack' (batch tail of the all-V/A
    // batch) to reach the followup batch.
    expect(calls).toContain('Soundtrack');
  });

  it('fans out variants across every artist_id in a name group; fanout_writes increments', async () => {
    const groupedBatch: NameGroup[] = [{ artist_name: 'Phoenix', artist_ids: [501, 502] }];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(groupedBatch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Phoenix', 2)],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 2 });

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    // Both 501 and 502 receive the variants.
    expect(writeArtistVariants).toHaveBeenCalledTimes(2);
    expect((writeArtistVariants.mock.calls[0] as unknown as [number])[0]).toBe(501);
    expect((writeArtistVariants.mock.calls[1] as unknown as [number])[0]).toBe(502);

    // fanout_writes counts every write to a name group with duplicate
    // artist_names — both 501 and 502 writes contribute (the group has
    // length > 1).
    expect(result.totals.fanout_writes).toBe(2);
  });

  it("appends 'wxyc_library_alt' to sources_present for every write", async () => {
    const batch: NameGroup[] = [{ artist_name: 'Stereolab', artist_ids: [7] }];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 1, ['discogs_name_variation'])],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map([[7, ['Stereo-Lab']]]));
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 2 });

    await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    const sourcesPresentArg = (
      writeArtistVariants.mock.calls[0] as unknown as [number, string, unknown[], string[]]
    )[3];
    expect(sourcesPresentArg).toContain('discogs_name_variation');
    expect(sourcesPresentArg).toContain('wxyc_library_alt');
    expect(sourcesPresentArg).toContain('wxyc_library_credit');
  });

  // The two BS#3554 cases build their doubles from plain functions plus an
  // inferred `jest.fn(impl)`, so they add nothing to this file's
  // typecheck:tests baseline (the explicit `jest.fn<Fn>()` form above is
  // what the baseline counts).
  const runOnce = (
    group: NameGroup,
    lml: ArtistSearchAliasesBulkResponse,
    alts: Map<number, string[]>,
    dryRun: boolean
  ) => {
    let served = false;
    const writeArtistVariants = jest.fn((..._args: Parameters<WriteFn>) => Promise.resolve({ variants_written: 0 }));
    const run = runConsumer({
      loadNameGroups: () => {
        const batch = served ? [] : [group];
        served = true;
        return Promise.resolve(batch);
      },
      fetchBulk: () => Promise.resolve(lml),
      fetchAlts: () => Promise.resolve(alts),
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun,
    });
    return { run, writeArtistVariants };
  };

  it('BS#3554: splits a comma-joined alt value into wxyc_library_credit rows and keeps the joined wxyc_library_alt row', async () => {
    // Two alt values. The first is the CA 49 credit; the second is a
    // single name, which already has its own wxyc_library_alt row, so it
    // adds no credit row. The same name in both must not produce a
    // duplicate credit row.
    const { run, writeArtistVariants } = runOnce(
      { artist_name: 'Carolina Chocolate Drops', artist_ids: [4901] },
      { artists: [makeLmlResult('Carolina Chocolate Drops', 0, ['discogs_name_variation'])], missing: [] },
      new Map([[4901, ['Rhiannon Giddens, Our Native Daughters', 'Rhiannon Giddens']]]),
      false
    );
    await run;

    const variants = writeArtistVariants.mock.calls[0][2] as Array<Record<string, unknown>>;
    const bySource = (source: string) => variants.filter((v) => v.source === source).map((v) => v.variant);
    expect(bySource('wxyc_library_alt')).toEqual(['Rhiannon Giddens, Our Native Daughters', 'Rhiannon Giddens']);
    expect(bySource('wxyc_library_credit')).toEqual(['Rhiannon Giddens', 'Our Native Daughters']);
    variants
      .filter((v) => v.source === 'wxyc_library_credit')
      .forEach((v) => {
        expect(v.method).toBe('alt_curated');
        expect(v.confidence).toBe(0.7);
      });
  });

  it('BS#3554: drops a credit piece equal to the owning artist and counts credit rows in DRY_RUN', async () => {
    const { run, writeArtistVariants } = runOnce(
      { artist_name: 'Mike Bloomfield', artist_ids: [11] },
      { artists: [], missing: ['Mike Bloomfield'] },
      new Map([[11, ['Mike Bloomfield, Al Kooper, and Steve Stills']]]),
      true
    );
    const result = await run;

    expect(writeArtistVariants).not.toHaveBeenCalled();
    // 1 joined wxyc_library_alt row + 2 credit rows (Al Kooper, Steve Stills).
    expect(result.totals.would_write_rows).toBe(3);
  });

  it('includes wxyc_library_alt variants with confidence 0.85 and method alt_curated', async () => {
    const batch: NameGroup[] = [{ artist_name: 'Stereolab', artist_ids: [7] }];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 0, ['discogs_name_variation'])],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map([[7, ['Stereo-Lab', 'Stereolab Band']]]));
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 2 });

    await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    const writeArgs = writeArtistVariants.mock.calls[0] as unknown as [
      number,
      string,
      Array<Record<string, unknown>>,
      string[],
    ];
    const variants = writeArgs[2];
    expect(variants.length).toBe(2);
    variants.forEach((v) => {
      expect(v.source).toBe('wxyc_library_alt');
      expect(v.method).toBe('alt_curated');
      expect(v.confidence).toBe(0.85);
    });
    const variantTexts = variants.map((v) => v.variant);
    expect(variantTexts).toEqual(expect.arrayContaining(['Stereo-Lab', 'Stereolab Band']));
  });

  it('suppresses writer in DRY_RUN; counters still update; emits a JSON summary on stdout', async () => {
    const writes: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const batch: NameGroup[] = [{ artist_name: 'Stereolab', artist_ids: [7, 8] }];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 1)],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 0 });

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: true,
    });

    expect(writeArtistVariants).not.toHaveBeenCalled();
    expect(result.totals.names_resolved).toBe(1);
    // Locked summary shape lands as a single JSON line on stdout.
    const dryRunLines = writes.map((s) => s.trim()).filter((s) => s.startsWith('{') && s.includes('would_resolve'));
    expect(dryRunLines.length).toBe(1);
    const parsed = JSON.parse(dryRunLines[0]);
    expect(parsed.would_resolve).toBe(1);
    expect(parsed.names_scanned).toBe(1);
    expect(parsed.would_write_rows).toBeGreaterThanOrEqual(0);
  });

  it('counts an LML error batch as names_missing; loop continues; cursor advances', async () => {
    const batches: NameGroup[][] = [
      [
        { artist_name: 'Stereolab', artist_ids: [7] },
        { artist_name: 'Juana Molina', artist_ids: [42] },
      ],
      [{ artist_name: 'Cat Power', artist_ids: [99] }],
      [],
    ];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockImplementation(() => Promise.resolve(batches.shift() ?? []));

    let callCount = 0;
    const fetchBulk = jest.fn<FetchBulkFn>().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error('LML 503'));
      return Promise.resolve({
        artists: [makeLmlResult('Cat Power', 1)],
        missing: [],
      });
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 1 });

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    // Both LML calls executed (no early return on the first failure).
    expect(fetchBulk).toHaveBeenCalledTimes(2);
    // Only the second batch produced a write.
    expect(writeArtistVariants).toHaveBeenCalledTimes(1);
    // Names from the failed batch land in names_missing.
    expect(result.totals.names_missing).toBe(2);
    // The second batch's name is resolved.
    expect(result.totals.names_resolved).toBe(1);
  });

  it('counts names absent from both artists[] and missing[] as names_unaccounted (not names_missing)', async () => {
    // Cardinality drift: LML responds successfully but the input "Cat Power"
    // is mentioned in neither bucket. This is upstream API drift, not a
    // real miss; the orchestrator must surface it on its own counter so
    // Sentry's `consumer.names_unaccounted` lights up.
    const batch: NameGroup[] = [
      { artist_name: 'Stereolab', artist_ids: [7] },
      { artist_name: 'Cat Power', artist_ids: [99] },
    ];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 1)],
      missing: [], // Cat Power is absent from BOTH lists — drift.
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 1 });

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    expect(result.totals.names_resolved).toBe(1);
    expect(result.totals.names_missing).toBe(0); // NOT bucketed as missing.
    expect(result.totals.names_unaccounted).toBe(1);
  });

  it("BS#1382: forwards the group's canonical artist_name to writeArtistVariants so the writer can gate no-op variants", async () => {
    // The writer's no-op-discogs_name_variation filter requires the
    // canonical `artists.artist_name` to normalize-compare against. The
    // orchestrator passes `group.artist_name` (the canonical it grouped
    // by) so the filter doesn't pay an extra DB round-trip per artist.
    // The audit case from BS#1368: canonical 'The Format', variant
    // 'Format'. We assert the canonical reaches the writer; the no-op
    // filter is verified in writer.test.ts.
    const batch: NameGroup[] = [{ artist_name: 'The Format', artist_ids: [260, 261] }];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('The Format', 1)],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());
    const writeArtistVariants = jest.fn<WriteFn>().mockResolvedValue({ variants_written: 1 });

    await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    // Both fan-out writes receive the canonical 'The Format' in slot [1].
    expect(writeArtistVariants).toHaveBeenCalledTimes(2);
    const firstCall = writeArtistVariants.mock.calls[0] as unknown as [number, string, unknown[], string[]];
    const secondCall = writeArtistVariants.mock.calls[1] as unknown as [number, string, unknown[], string[]];
    expect(firstCall[1]).toBe('The Format');
    expect(secondCall[1]).toBe('The Format');
  });

  it('counts per-artist writer failures into the writer_errors counter (source_rows_written unaffected)', async () => {
    const batch: NameGroup[] = [
      { artist_name: 'Stereolab', artist_ids: [7] },
      { artist_name: 'Juana Molina', artist_ids: [42] },
    ];
    const loadNameGroups = jest.fn<LoadNameGroupsFn>().mockResolvedValueOnce(batch).mockResolvedValue([]);

    const fetchBulk = jest.fn<FetchBulkFn>().mockResolvedValue({
      artists: [makeLmlResult('Stereolab', 2), makeLmlResult('Juana Molina', 1)],
      missing: [],
    });
    const fetchAlts = jest.fn<FetchAltsFn>().mockResolvedValue(new Map());

    // First write succeeds, second throws.
    let callCount = 0;
    const writeArtistVariants = jest.fn<WriteFn>().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve({ variants_written: 2 });
      return Promise.reject(new Error('PG connection reset'));
    });

    const result = await runConsumer({
      loadNameGroups,
      fetchBulk,
      fetchAlts,
      writeArtistVariants,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { index: 0, count: 1, description: 'partition=none' },
      dryRun: false,
    });

    expect(result.totals.writer_errors).toBe(1);
    // source_rows_written reflects only the successful write.
    expect(result.totals.source_rows_written).toBe(2);
    // Both names still count as resolved on the LML side.
    expect(result.totals.names_resolved).toBe(2);
  });
});
