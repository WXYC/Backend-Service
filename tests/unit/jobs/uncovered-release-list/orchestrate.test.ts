/**
 * Unit tests for the uncovered-release-list orchestrator (BS#1877). All
 * dependencies (rotation fetch, resolve, both anti-joins, write, publish,
 * markers) are injected fakes — no network, no DB, no filesystem. Mirrors
 * `album-critic-reviews-etl/orchestrate.test.ts`'s structure. Covers the two
 * run guards (zero active rows, zero resolved), the dedup/anti-join
 * counters, DRY_RUN's zero-writes/zero-network-calls contract, and —
 * specific to this job — that `recordHandoffs` is called ONLY when publish
 * actually commits (the found-nothing marker's core correctness property;
 * see orchestrate.ts step 8 and markers.ts's doc comment).
 */
import {
  runJob,
  resolveDryRun,
  type RunOptions,
  type Totals,
} from '../../../../jobs/uncovered-release-list/orchestrate';
import type { RotationRow, CanonicalRelease } from '../../../../jobs/uncovered-release-list/rotation';
import type { PublishOutcome } from '../../../../jobs/uncovered-release-list/publish';
import { initLogger, closeLogger } from '../../../../jobs/uncovered-release-list/logger';

beforeAll(() => {
  initLogger({ repo: 'Backend-Service', tool: 'uncovered-release-list-test' });
});

afterAll(async () => {
  await closeLogger();
});

const row = (overrides: Partial<RotationRow> = {}): RotationRow => ({
  rotationId: 1,
  libraryId: 42,
  artistName: 'Tony Allen',
  albumTitle: 'What goes up',
  ...overrides,
});

const releaseFor = (r: RotationRow): CanonicalRelease => ({
  libraryId: r.libraryId ?? -1,
  artist: r.artistName,
  album: r.albumTitle,
});

const committedPublish: PublishOutcome = { attempted: true, committed: true, commitSha: 'abc' };
const disabledPublish: PublishOutcome = { attempted: false, committed: false, reason: 'PUBLISH is not enabled' };

type TestOpts = RunOptions & {
  writeCalls: Array<{ content: string; path: string }>;
  publishCalls: string[];
  recordHandoffsCalls: number[][];
};

const makeOpts = (overrides: Partial<RunOptions> = {}): TestOpts => {
  const writeCalls: Array<{ content: string; path: string }> = [];
  const publishCalls: string[] = [];
  const recordHandoffsCalls: number[][] = [];

  const opts: TestOpts = {
    fetchActiveRotation: () => Promise.resolve([row()]),
    resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
    loadCovered: () => Promise.resolve(new Set<number>()),
    loadHandedOff: () => Promise.resolve(new Set<number>()),
    writeSnapshot: (content, path) => {
      writeCalls.push({ content, path });
      return Promise.resolve({ path });
    },
    recordHandoffs: (libraryIds) => {
      recordHandoffsCalls.push(libraryIds);
      return Promise.resolve(libraryIds.length);
    },
    publish: (content) => {
      publishCalls.push(content);
      return Promise.resolve(committedPublish);
    },
    outputPath: './output/uncovered-releases.jsonl',
    writeCalls,
    publishCalls,
    recordHandoffsCalls,
    ...overrides,
  };
  return opts;
};

describe('runJob — run guards', () => {
  it('throws when active rotation read returns 0 rows', async () => {
    const opts = makeOpts({ fetchActiveRotation: () => Promise.resolve([]) });
    await expect(runJob(opts)).rejects.toThrow(/0 rows/i);
  });

  it('throws when zero rows resolve to a library.id', async () => {
    const opts = makeOpts({ resolveCanonical: () => Promise.resolve(null) });
    await expect(runJob(opts)).rejects.toThrow(/resolved/i);
  });

  it('the zero-resolved guard fires even in DRY_RUN', async () => {
    const opts = makeOpts({ resolveCanonical: () => Promise.resolve(null), dryRun: true });
    await expect(runJob(opts)).rejects.toThrow(/resolved/i);
  });
});

describe('runJob — counters', () => {
  it('counts resolved/unresolved_dropped and dedups duplicate library ids', async () => {
    const rows = [
      row({ rotationId: 1, libraryId: 1 }),
      row({ rotationId: 2, libraryId: 1 }), // duplicate release, same library.id
      row({ rotationId: 3, libraryId: null, artistName: 'Unresolvable', albumTitle: 'Nope' }),
    ];
    const opts = makeOpts({
      fetchActiveRotation: () => Promise.resolve(rows),
      resolveCanonical: (r) => Promise.resolve(r.libraryId === null ? null : releaseFor(r)),
    });

    const totals: Totals = await runJob(opts);

    expect(totals.active_rotation_rows).toBe(3);
    expect(totals.resolved).toBe(2);
    expect(totals.unresolved_dropped).toBe(1);
    expect(totals.deduped).toBe(1); // two resolved rows, same library.id, collapse to one
  });

  it('already_covered and already_handed_off are mutually exclusive in their counts, and both are excluded from uncovered', async () => {
    const rows = [
      row({ rotationId: 1, libraryId: 1 }),
      row({ rotationId: 2, libraryId: 2 }),
      row({ rotationId: 3, libraryId: 3 }),
    ];
    const opts = makeOpts({
      fetchActiveRotation: () => Promise.resolve(rows),
      resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
      loadCovered: () => Promise.resolve(new Set([1])),
      loadHandedOff: () => Promise.resolve(new Set([1, 2])), // 1 is in BOTH sets
    });

    const totals = await runJob(opts);

    expect(totals.deduped).toBe(3);
    expect(totals.already_covered).toBe(1);
    expect(totals.already_handed_off).toBe(1); // only library.id 2 (1 is counted under already_covered, not double-counted here)
    expect(totals.uncovered).toBe(1); // only library.id 3 survives both anti-joins
  });
});

describe('runJob — real run: write, publish, and the publish-gated marker write', () => {
  it('writes the rendered snapshot and publishes the SAME content', async () => {
    const opts = makeOpts();
    await runJob(opts);

    expect(opts.writeCalls).toHaveLength(1);
    expect(opts.publishCalls).toHaveLength(1);
    expect(opts.writeCalls[0].content).toBe(opts.publishCalls[0]);
    expect(opts.writeCalls[0].path).toBe(opts.outputPath);
    expect(JSON.parse(opts.writeCalls[0].content.trim())).toEqual({
      artist: 'Tony Allen',
      album: 'What goes up',
      library_id: 42,
    });
  });

  it('records handoff markers for the uncovered library ids WHEN publish commits', async () => {
    const opts = makeOpts({ publish: () => Promise.resolve(committedPublish) });
    const totals = await runJob(opts);

    expect(opts.recordHandoffsCalls).toEqual([[42]]);
    expect(totals.published).toBe(true);
    expect(totals.marked_handed_off).toBe(1);
  });

  it('does NOT record handoff markers when publish is disabled (attempted: false)', async () => {
    const opts = makeOpts({ publish: () => Promise.resolve(disabledPublish) });
    const totals = await runJob(opts);

    expect(opts.recordHandoffsCalls).toHaveLength(0);
    expect(totals.published).toBe(false);
    expect(totals.marked_handed_off).toBe(0);
    // The local file write still happened regardless of publish being off.
    expect(opts.writeCalls).toHaveLength(1);
  });

  it('does NOT record handoff markers when publish THROWS — isolates the failure, does not abort the run', async () => {
    const opts = makeOpts({ publish: () => Promise.reject(new Error('network down')) });
    const totals = await runJob(opts);

    expect(opts.recordHandoffsCalls).toHaveLength(0);
    expect(totals.published).toBe(false);
    expect(opts.writeCalls).toHaveLength(1); // still wrote the local file before publish was attempted
  });

  it('still writes + attempts publish even when the uncovered set is empty (a meaningful empty snapshot)', async () => {
    const opts = makeOpts({ loadCovered: () => Promise.resolve(new Set([42])) });
    const totals = await runJob(opts);

    expect(totals.uncovered).toBe(0);
    expect(opts.writeCalls).toHaveLength(1);
    expect(opts.writeCalls[0].content).toBe('');
    expect(opts.publishCalls).toHaveLength(1);
    expect(opts.recordHandoffsCalls).toEqual([[]]); // called with an empty list, not skipped
  });
});

describe('runJob — DRY_RUN', () => {
  it('makes zero write/publish/recordHandoffs calls and emits the locked-schema JSON report line', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const rows = [row({ rotationId: 1, libraryId: 1 }), row({ rotationId: 2, libraryId: 2 })];
      const opts = makeOpts({
        fetchActiveRotation: () => Promise.resolve(rows),
        resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
        loadCovered: () => Promise.resolve(new Set([1])),
        dryRun: true,
      });

      const totals = await runJob(opts);

      expect(opts.writeCalls).toHaveLength(0);
      expect(opts.publishCalls).toHaveLength(0);
      expect(opts.recordHandoffsCalls).toHaveLength(0);
      expect(totals).toMatchObject({ deduped: 2, already_covered: 1, uncovered: 1, written: 0, published: false });

      const reportLine = stdoutSpy.mock.calls.map((c) => String(c[0])).find((line) => line.includes('"uncovered"'));
      if (reportLine === undefined) throw new Error('no dry-run report line written to stdout');
      const report = JSON.parse(reportLine.trim());
      expect(report).toEqual({
        job: 'uncovered-release-list',
        dry_run: true,
        active_rotation_rows: 2,
        resolved: 2,
        unresolved_dropped: 0,
        deduped: 2,
        already_covered: 1,
        already_handed_off: 0,
        uncovered: 1,
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('runJob — nothing-new steady state', () => {
  it('logs a distinct nothing_new step when the uncovered set is empty', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const opts = makeOpts({ loadCovered: () => Promise.resolve(new Set([42])) });
      await runJob(opts);

      const lines = stdoutSpy.mock.calls.map((c) => String(c[0]));
      const nothingNewLine = lines.find((line) => line.includes('"step":"nothing_new"'));
      expect(nothingNewLine).toBeDefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('resolveDryRun', () => {
  it.each<[string | undefined, boolean]>([
    [undefined, false],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', false],
  ])('resolves %p -> %p (locked truthy set: true|1, case-insensitive)', (raw, expected) => {
    expect(resolveDryRun(raw)).toBe(expected);
  });
});
