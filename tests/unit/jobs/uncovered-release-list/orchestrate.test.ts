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
    fetchPlayCandidates: () => Promise.resolve([]),
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
    maxReleasesPerRun: 400,
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

  it('still writes the empty snapshot LOCALLY when the uncovered set is empty (a meaningful empty artifact)', async () => {
    const opts = makeOpts({ loadCovered: () => Promise.resolve(new Set([42])) });
    const totals = await runJob(opts);

    expect(totals.uncovered).toBe(0);
    expect(opts.writeCalls).toHaveLength(1);
    expect(opts.writeCalls[0].content).toBe('');
  });

  it('does NOT publish an empty snapshot — an empty whole-file replace would destroy a previous, already-marked snapshot', async () => {
    const opts = makeOpts({ loadCovered: () => Promise.resolve(new Set([42])) });
    const totals = await runJob(opts);

    expect(totals.uncovered).toBe(0);
    // Publishing is a whole-file replace of one fixed path and markers are
    // publish-once, so an empty publish hands off nothing while wiping a
    // snapshot whose releases can never be re-offered. Hold the old file.
    expect(opts.publishCalls).toHaveLength(0);
    expect(totals.published).toBe(false);
    // No commit means no new markers — nothing was handed off.
    expect(opts.recordHandoffsCalls).toEqual([]);
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

      // The report literal is the only stdout line starting with `{"job":` —
      // logger lines start with `{"timestamp":` and the cap-fired warn line
      // also carries an `"uncovered"` field, so an .includes() match would
      // find the wrong line and pass vacuously.
      const reportLine = stdoutSpy.mock.calls.map((c) => String(c[0])).find((line) => line.startsWith('{"job":'));
      if (reportLine === undefined) throw new Error('no dry-run report line written to stdout');
      const report = JSON.parse(reportLine.trim());
      expect(report).toEqual({
        job: 'uncovered-release-list',
        dry_run: true,
        backfill: false,
        active_rotation_rows: 2,
        resolved: 2,
        unresolved_dropped: 0,
        recent_play_rows: 0,
        candidate_rows: 2,
        deduped: 2,
        already_covered: 1,
        already_handed_off: 0,
        uncovered: 1,
        capped_out: 0,
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('capped_out is non-zero under DRY_RUN when the cap fires — the exact mode an operator uses to check it', async () => {
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const rows = [1, 2, 3].map((id) => row({ rotationId: id, libraryId: id }));
      const opts = makeOpts({
        fetchActiveRotation: () => Promise.resolve(rows),
        resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
        maxReleasesPerRun: 1,
        dryRun: true,
      });

      const totals = await runJob(opts);

      expect(totals.uncovered).toBe(3);
      expect(totals.capped_out).toBe(2);
      expect(opts.writeCalls).toHaveLength(0);

      // The report literal is the only stdout line starting with `{"job":` —
      // logger lines start with `{"timestamp":` and the cap-fired warn line
      // also carries an `"uncovered"` field, so an .includes() match would
      // find the wrong line and pass vacuously.
      const reportLine = stdoutSpy.mock.calls.map((c) => String(c[0])).find((line) => line.startsWith('{"job":'));
      if (reportLine === undefined) throw new Error('no dry-run report line written to stdout');
      expect(JSON.parse(reportLine.trim()).capped_out).toBe(2);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('runJob — play arm: concat + dedup precedence', () => {
  it('an album in both arms keeps its rotation-arm canonical fields (rotation-first, first-wins dedup)', async () => {
    const rotationRelease: CanonicalRelease = { libraryId: 7, artist: 'Rotation Artist', album: 'Rotation Album' };
    const playRelease: CanonicalRelease = {
      libraryId: 7,
      artist: 'Play Artist (must lose)',
      album: 'Play Album (must lose)',
    };
    const opts = makeOpts({
      fetchActiveRotation: () => Promise.resolve([row({ rotationId: 1, libraryId: 7 })]),
      resolveCanonical: () => Promise.resolve(rotationRelease),
      fetchPlayCandidates: () => Promise.resolve([playRelease]),
    });

    const totals = await runJob(opts);

    expect(totals.recent_play_rows).toBe(1);
    expect(totals.candidate_rows).toBe(2); // 1 resolved + 1 play, post-concat/pre-dedup
    expect(totals.deduped).toBe(1);
    expect(JSON.parse(opts.writeCalls[0].content.trim())).toEqual({
      artist: 'Rotation Artist',
      album: 'Rotation Album',
      library_id: 7,
    });
  });

  it('includes a play-arm-only release (no rotation counterpart) in the candidate set', async () => {
    const playOnly: CanonicalRelease = { libraryId: 55, artist: 'Play Only Artist', album: 'Play Only Album' };
    const opts = makeOpts({ fetchPlayCandidates: () => Promise.resolve([playOnly]) });

    const totals = await runJob(opts);

    expect(totals.recent_play_rows).toBe(1);
    expect(totals.deduped).toBe(2); // default rotation row (library.id 42) + play-only (55)
    const ids = opts.writeCalls[0].content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).library_id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([42, 55]);
  });
});

describe('runJob — cap', () => {
  it('truncates the uncovered set at maxReleasesPerRun and reports capped_out at the cap site', async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row({ rotationId: id, libraryId: id }));
    const opts = makeOpts({
      fetchActiveRotation: () => Promise.resolve(rows),
      resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
      maxReleasesPerRun: 2,
    });

    const totals = await runJob(opts);

    expect(totals.uncovered).toBe(5);
    expect(totals.capped_out).toBe(3);
    expect(totals.written).toBe(2);
    expect(opts.writeCalls[0].content.trim().split('\n')).toHaveLength(2);
  });

  it('capped_out is 0 when the cap does not fire', async () => {
    const totals = await runJob(makeOpts({ maxReleasesPerRun: 400 }));
    expect(totals.capped_out).toBe(0);
  });

  it('the capped list — not the uncovered list — is the single input to render/write/publish/recordHandoffs', async () => {
    const rows = [1, 2, 3].map((id) => row({ rotationId: id, libraryId: id }));
    const opts = makeOpts({
      fetchActiveRotation: () => Promise.resolve(rows),
      resolveCanonical: (r) => Promise.resolve(releaseFor(r)),
      maxReleasesPerRun: 1,
    });

    const totals = await runJob(opts);

    expect(totals.uncovered).toBe(3);
    expect(totals.capped_out).toBe(2);
    const writtenIds = opts.writeCalls[0].content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).library_id);
    const publishedIds = opts.publishCalls[0]
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).library_id);
    expect(writtenIds).toEqual([1]); // first release in dedup order (rotationId 1)
    expect(publishedIds).toEqual(writtenIds); // write + publish share the identical rendered content
    expect(opts.recordHandoffsCalls).toEqual([writtenIds]); // markers written for the capped set only
  });
});

describe('runJob — zero play rows (non-throwing escalation)', () => {
  it('does not throw; logs a loud error-level plays_empty step and the run still completes', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const opts = makeOpts({ fetchPlayCandidates: () => Promise.resolve([]) });

      const totals = await runJob(opts);

      expect(totals.recent_play_rows).toBe(0);
      expect(totals.published).toBe(true); // run completed normally, exit stays 0

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((line) => line.includes('"step":"plays_empty"'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('runJob — rotation-lane guard demotion under --backfill', () => {
  it('demotes the zero-active-rotation guard to log+Sentry and continues the drain on the play arm alone', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const playOnly: CanonicalRelease = { libraryId: 9, artist: 'Play Only', album: 'Play Only Album' };
      const opts = makeOpts({
        fetchActiveRotation: () => Promise.resolve([]),
        fetchPlayCandidates: () => Promise.resolve([playOnly]),
        backfill: true,
      });

      const totals = await runJob(opts);

      expect(totals.active_rotation_rows).toBe(0);
      expect(totals.resolved).toBe(0);
      expect(totals.recent_play_rows).toBe(1);
      expect(totals.uncovered).toBe(1);
      expect(totals.published).toBe(true); // did not throw; the run completed on the play arm alone

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((line) => line.includes('"step":"rotation_empty_backfill"'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('demotes the zero-resolved guard to log+Sentry and continues the drain on the play arm alone', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const playOnly: CanonicalRelease = { libraryId: 11, artist: 'Play Only', album: 'Play Only Album' };
      const opts = makeOpts({
        resolveCanonical: () => Promise.resolve(null),
        fetchPlayCandidates: () => Promise.resolve([playOnly]),
        backfill: true,
      });

      const totals = await runJob(opts);

      expect(totals.resolved).toBe(0);
      expect(totals.unresolved_dropped).toBe(1);
      expect(totals.recent_play_rows).toBe(1);
      expect(totals.uncovered).toBe(1);
      expect(totals.published).toBe(true); // did not throw

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((line) => line.includes('"step":"resolve_empty_backfill"'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('does NOT demote in steady state (backfill unset) — both rotation-lane guards still hard-throw', async () => {
    await expect(runJob(makeOpts({ fetchActiveRotation: () => Promise.resolve([]) }))).rejects.toThrow(/0 rows/i);
    await expect(runJob(makeOpts({ resolveCanonical: () => Promise.resolve(null) }))).rejects.toThrow(/resolved/i);
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
