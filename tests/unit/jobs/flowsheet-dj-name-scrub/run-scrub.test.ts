/**
 * Control-flow tests for `runScrub` (BS#2281).
 *
 * Driven entirely through the injectable seams (loadUsers / loadMainPage /
 * loadMessagePage / loadOrphanPage / applyDjNameBatch / applyMessageBatch /
 * analyzeFlowsheet / checkLiveActivity) rather than the raw db mock chain,
 * mirroring tests/unit/jobs/flowsheet-ghost-row-sweep and
 * tests/unit/jobs/flowsheet-april-gap-import.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { CheckLiveActivityFn } from '@wxyc/database';
import {
  runScrub,
  requestStop,
  __resetStopForTesting,
  type ScrubRow,
  type MessageRow,
  type DjNameFix,
  type MessageFix,
} from '../../../../jobs/flowsheet-dj-name-scrub/orchestrate';

const ROSTER = [
  { name: 'A. Hearst', djName: null },
  { name: 'B. Wilder', djName: 'zorp' },
];

const makeRow = (overrides: Partial<ScrubRow> = {}): ScrubRow => ({
  id: 1,
  entry_type: 'track',
  dj_name: 'A. Hearst',
  message: null,
  show_id: 500,
  dj_name_override: null,
  legacy_dj_name: null,
  primary_dj_id: 'user-1',
  user_found: true,
  user_dj_name: 'zorp',
  ...overrides,
});

/** Serve `pages` in order, then drain. Mirrors the id-cursor contract. */
const pager = <T>(pages: T[][]) => {
  let call = 0;
  return jest.fn(() => Promise.resolve(pages[call++] ?? []));
};

const baseOpts = () => ({
  dryRun: true,
  batchSize: 100,
  mainAfterId: 0,
  messageAfterId: 0,
  orphanAfterId: 0,
  liveActivityLookbackSeconds: 0,
  loadUsers: jest.fn(() => Promise.resolve(ROSTER)),
  loadShowsLegacyDjNames: jest.fn(() => Promise.resolve([])),
  loadMainPage: pager<ScrubRow>([]),
  loadMessagePage: pager<MessageRow>([]),
  loadOrphanPage: pager<ScrubRow>([]),
  applyDjNameBatch: jest.fn((fixes: DjNameFix[]) => Promise.resolve(fixes.length)),
  applyMessageBatch: jest.fn((fixes: MessageFix[]) => Promise.resolve(fixes.length)),
  analyzeFlowsheet: jest.fn(() => Promise.resolve()),
  verifyScrub: jest.fn(() => Promise.resolve(0)),
});

beforeEach(() => {
  __resetStopForTesting();
});

describe('dry-run is the default posture', () => {
  it('counts changes but issues no write', async () => {
    const opts = baseOpts();
    opts.loadMainPage = pager([[makeRow({ id: 1 }), makeRow({ id: 2, dj_name: 'zorp' })]]);

    const result = await runScrub(opts);

    expect(result.dryRun).toBe(true);
    expect(result.main.scanned).toBe(2);
    expect(result.main.changed).toBe(1); // id 2 already holds the recomputed value
    expect(result.main.written).toBe(0);
    expect(opts.applyDjNameBatch).not.toHaveBeenCalled();
  });

  it('skips ANALYZE and verification when nothing was written', async () => {
    const opts = baseOpts();
    opts.loadMainPage = pager([[makeRow()]]);

    await runScrub(opts);

    expect(opts.analyzeFlowsheet).not.toHaveBeenCalled();
    expect(opts.verifyScrub).not.toHaveBeenCalled();
  });
});

describe('dry-run and live share one decision path', () => {
  // BS#1393's dry-run preview counted a WIDER predicate than its live UPDATE
  // applied, while its doc comment claimed the two matched. The only durable
  // fix is one code path, asserted.
  it('flags exactly the same rows under --execute as under dry-run', async () => {
    const rows = [
      makeRow({ id: 1, dj_name: 'A. Hearst' }),
      makeRow({ id: 2, dj_name: 'zorp' }),
      makeRow({ id: 3, entry_type: 'talkset', dj_name: null }),
      makeRow({ id: 4, entry_type: 'dj_join', dj_name: 'A. Hearst' }),
      makeRow({ id: 5, entry_type: 'dj_join', dj_name: 'guest handle' }),
    ];

    const dry = baseOpts();
    dry.loadMainPage = pager([[...rows]]);
    const dryResult = await runScrub(dry);

    const live = baseOpts();
    live.dryRun = false;
    live.loadMainPage = pager([[...rows]]);
    const liveResult = await runScrub(live);

    expect(liveResult.main.changed).toBe(dryResult.main.changed);
    expect(liveResult.main.sample).toEqual(dryResult.main.sample);
    expect(liveResult.main.by_reason).toEqual(dryResult.main.by_reason);
    expect(liveResult.main.written).toBe(dryResult.main.changed);
  });

  it('never hands an excluded entry type to the write path', async () => {
    const live = baseOpts();
    live.dryRun = false;
    live.loadMainPage = pager([
      [
        makeRow({ id: 10, entry_type: 'talkset', dj_name: null }),
        makeRow({ id: 11, entry_type: 'breakpoint', dj_name: null }),
        makeRow({ id: 12, entry_type: 'message', dj_name: null }),
        makeRow({ id: 13, entry_type: 'track', dj_name: 'A. Hearst' }),
      ],
    ]);

    await runScrub(live);

    const written = live.applyDjNameBatch.mock.calls.flatMap(([fixes]) => fixes);
    expect(written.map((f) => f.id)).toEqual([13]);
  });
});

describe('ANALYZE ordering (BS#934)', () => {
  it('runs ANALYZE after every pass has drained, not between them', async () => {
    const order: string[] = [];
    const opts = baseOpts();
    opts.dryRun = false;
    opts.loadMainPage = pager([[makeRow({ id: 1 })]]);
    opts.loadMessagePage = pager([[{ id: 2, entry_type: 'dj_join' as const, message: 'A. Hearst joined the set!' }]]);
    opts.loadOrphanPage = pager([[makeRow({ id: 3, show_id: null, primary_dj_id: null, user_found: false })]]);
    opts.applyDjNameBatch = jest.fn((fixes: DjNameFix[]) => {
      order.push('write_dj_name');
      return Promise.resolve(fixes.length);
    });
    opts.applyMessageBatch = jest.fn((fixes: MessageFix[]) => {
      order.push('write_message');
      return Promise.resolve(fixes.length);
    });
    opts.analyzeFlowsheet = jest.fn(() => {
      order.push('analyze');
      return Promise.resolve();
    });

    await runScrub(opts);

    expect(order).toEqual(['write_dj_name', 'write_message', 'write_dj_name', 'analyze']);
    expect(order.indexOf('analyze')).toBe(order.length - 1);
  });
});

describe('resumable abort on the cooperative-pause ceiling', () => {
  // `buildWaitForQuietPeriod` THROWS LiveActivityPauseCeilingExceededError
  // once the cumulative pause budget is spent, and docs/env-vars.md:34 is
  // emphatic that a TypeScript job must abort there rather than silently
  // continue. So the run CAN end mid-drain by design — which makes persisting
  // all three cursors before the throw propagates the difference between a
  // resumable pass and a lost multi-hour one.
  it('persists all three cursors when the pause ceiling aborts the run', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.mainAfterId = 7;
    opts.messageAfterId = 11;
    opts.orphanAfterId = 13;
    opts.liveActivityLookbackSeconds = 60;
    // @ts-expect-error -- narrow test seam, not part of the public opts type
    opts.liveActivityPauseMs = 1;
    // @ts-expect-error -- narrow test seam, not part of the public opts type
    opts.liveActivityMaxPauseMs = 1;
    // Quiet for the first page, then busy forever: the budget is exhausted on
    // the SECOND probe, so this is a genuine mid-drain abort rather than a
    // refusal to start. `buildWaitForQuietPeriod` spends the whole ceiling
    // inside ONE call (it loops probe -> pause -> probe), so a probe that
    // reports activity from the very first turn never lets a page land —
    // that case is the separate test below.
    opts.checkLiveActivity = jest.fn<CheckLiveActivityFn>().mockResolvedValueOnce(false).mockResolvedValue(true);
    opts.loadMainPage = pager([[makeRow({ id: 41 })], [makeRow({ id: 42 })]]);

    const result = await runScrub(opts);

    expect(result.failed).toBe(true);
    // The cursor advanced past the page that actually committed...
    expect(result.main.last_id).toBe(41);
    // ...and the passes that never started report the operator's own cursor
    // back, not a misleading 0.
    expect(result.message.last_id).toBe(11);
    expect(result.orphan.last_id).toBe(13);
  });

  it('reports the operator cursors unchanged when the very first probe aborts', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.mainAfterId = 7;
    opts.messageAfterId = 11;
    opts.orphanAfterId = 13;
    opts.liveActivityLookbackSeconds = 60;
    // @ts-expect-error -- narrow test seam
    opts.liveActivityPauseMs = 1;
    // @ts-expect-error -- narrow test seam
    opts.liveActivityMaxPauseMs = 1;
    opts.checkLiveActivity = jest.fn(() => Promise.resolve(true));
    opts.loadMainPage = pager([[makeRow({ id: 41 })]]);

    const result = await runScrub(opts);

    expect(result.failed).toBe(true);
    expect(result.main.last_id).toBe(7);
    expect(result.message.last_id).toBe(11);
    expect(result.orphan.last_id).toBe(13);
  });
});

describe('graceful stop', () => {
  it('finishes the in-flight page and reports a resume cursor', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.loadMainPage = jest.fn(() => {
      requestStop();
      return Promise.resolve([makeRow({ id: 99 })]);
    });

    const result = await runScrub(opts);

    expect(result.stopped).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.main.last_id).toBe(99);
  });
});

describe('verification is bounded to the drain high-water mark', () => {
  // Two live writers still re-derive the chain in SQL
  // (jobs/flowsheet-etl/job.ts:121, apps/backend/routes/internal.route.ts:195)
  // and can write a value the canonical helper would not produce. An
  // unbounded "zero rows differ" check would fail nondeterministically on any
  // row they touch after the drain passed it.
  it('passes the observed high-water mark to the verifier', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.loadMainPage = pager([[makeRow({ id: 100 }), makeRow({ id: 250 })]]);

    const result = await runScrub(opts);

    expect(opts.verifyScrub).toHaveBeenCalledWith(expect.objectContaining({ highWaterMark: 250 }));
    expect(result.highWaterMark).toBe(250);
    expect(result.remaining).toBe(0);
  });

  // BS#2281 review finding 9: verifyScrub must re-scan with the SAME loaders
  // the drain passes used, not the module-level defaults — otherwise a test
  // (or a future caller) injecting only the loaders, not verifyScrub itself,
  // would silently hit a real database during verification.
  it('threads the injected loaders through to the verifier by reference, not the module defaults', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.loadMainPage = pager([[makeRow({ id: 100 })]]);

    await runScrub(opts);

    expect(opts.verifyScrub).toHaveBeenCalledWith(
      expect.objectContaining({
        loadMainPage: opts.loadMainPage,
        loadOrphanPage: opts.loadOrphanPage,
        loadMessagePage: opts.loadMessagePage,
      })
    );
  });

  it('the REAL verifyScrub also uses the injected loaders, never the module-level defaults', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    delete (opts as { verifyScrub?: unknown }).verifyScrub;

    let mainCallCount = 0;
    opts.loadMainPage = jest.fn(() => {
      mainCallCount += 1;
      if (mainCallCount === 1) return Promise.resolve([makeRow({ id: 100 })]); // the drain's data page (stale)
      if (mainCallCount === 3) return Promise.resolve([makeRow({ id: 100, dj_name: 'zorp' })]); // verify's re-read (clean)
      return Promise.resolve([]); // call 2: the drain's own empty terminator page
    });

    const result = await runScrub(opts);

    // Three calls, all through the SAME injected mock: the drain's data
    // page, the drain's empty terminator, and verifyScrub's re-read. If
    // verifyScrub had fallen back to the module-level loadMainPage instead
    // of the injected one, it would have hit a real (unmocked)
    // `db.execute` call and thrown in this unit-test environment.
    expect(mainCallCount).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.failed).toBe(false);
  });

  it('fails the run when verification finds residue below the mark', async () => {
    const opts = baseOpts();
    opts.dryRun = false;
    opts.loadMainPage = pager([[makeRow({ id: 100 })]]);
    opts.verifyScrub = jest.fn(() => Promise.resolve(3));

    const result = await runScrub(opts);

    expect(result.remaining).toBe(3);
    expect(result.failed).toBe(true);
  });
});

describe('no re-derived chain in this job', () => {
  // shared/database/src/dj-name.ts:1-13 records why the helpers were
  // extracted: a jobs/ writer re-deriving the chain in SQL is exactly what
  // went wrong before. A scrub that exists to remove a helper-vs-data
  // divergence must not reintroduce it in its own implementation.
  const source = readFileSync(join(__dirname, '../../../../jobs/flowsheet-dj-name-scrub/orchestrate.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('imports the canonical helpers from @wxyc/database', () => {
    expect(code).toMatch(/import\s*\{[^}]*resolveShowDjName[^}]*\}\s*from\s*'@wxyc\/database'/s);
    expect(code).toMatch(/import\s*\{[^}]*resolveDjDisplayName[^}]*\}\s*from\s*'@wxyc\/database'/s);
    expect(code).toMatch(/import\s*\{[^}]*showDjNameOverride[^}]*\}\s*from\s*'@wxyc\/database'/s);
  });

  it('contains no COALESCE over a name column', () => {
    expect(code).not.toMatch(/COALESCE/i);
  });

  it('never selects auth_user.name into the recompute path', () => {
    // `name` reaches this job only to build the PII index (what must be
    // REMOVED), never as a fallback source for a value to write.
    expect(code).not.toMatch(/dj_name\s*=\s*[^;]*u\."?name"?/i);
  });
});

describe('the message pass counts each marker type separately', () => {
  // Two of the four rewrites introduce a message shape that has never existed
  // in the corpus (`dj_join`, `dj_leave`); the other two degrade to wording
  // their own writers already emit. An operator reviewing the dry run needs to
  // see how many of each — a single lumped total would hide the new-shape
  // count behind the safe one.
  it('breaks the rewrite count down by entry_type', async () => {
    const opts = baseOpts();
    opts.loadMessagePage = pager<MessageRow>([
      [
        { id: 1, entry_type: 'dj_join', message: 'A. Hearst joined the set!' },
        { id: 2, entry_type: 'dj_leave', message: 'A. Hearst left the set!' },
        { id: 3, entry_type: 'show_start', message: 'Start of Show: A. Hearst joined the set at 6/8/2026, 9:05:52 PM' },
        { id: 4, entry_type: 'show_end', message: 'End of Show: A. Hearst left the set at 6/8/2026, 11:58:02 PM' },
        { id: 5, entry_type: 'dj_join', message: 'zorp joined the set!' },
      ],
    ]);

    const result = await runScrub(opts);

    expect(result.message.changed).toBe(4);
    expect(result.message.by_reason).toMatchObject({
      'message_pii_rewritten:dj_join': 1,
      'message_pii_rewritten:dj_leave': 1,
      'message_pii_rewritten:show_start': 1,
      'message_pii_rewritten:show_end': 1,
      not_pii: 1,
    });
  });
});

describe('change-class provenance reaches the summary', () => {
  it('classifies every would-be write and samples ids per class', async () => {
    const opts = baseOpts();
    opts.loadMainPage = pager([
      [
        // stored holds a roster real name -> the class this job exists for
        makeRow({ id: 1, dj_name: 'A. Hearst', user_dj_name: 'zorp' }),
        // cosmetic only: same value, different padding
        makeRow({ id: 2, dj_name: '  zorp  ', user_dj_name: 'zorp' }),
        // a gap fill: nothing is being removed
        makeRow({ id: 3, dj_name: null, user_dj_name: 'zorp' }),
        // a plain handle change: legitimate, but NOT PII removal
        makeRow({ id: 4, dj_name: 'old handle', user_dj_name: 'zorp' }),
      ],
    ]);

    const result = await runScrub(opts);

    expect(result.main.by_change_class).toEqual({
      stored_is_roster_real_name: 1,
      whitespace_only: 1,
      stored_null: 1,
      other_value_change: 1,
    });
    expect(result.main.change_class_samples.stored_is_roster_real_name).toEqual([1]);
    expect(result.main.change_class_samples.whitespace_only).toEqual([2]);
  });

  it('samples ids only, never dj_name values', async () => {
    // A sample carrying values would put DJs' legal names into every log sink
    // this job writes to — stdout, Sentry, CloudWatch.
    const opts = baseOpts();
    opts.loadMainPage = pager([[makeRow({ id: 7, dj_name: 'A. Hearst', user_dj_name: 'zorp' })]]);

    const result = await runScrub(opts);

    const serialized = JSON.stringify(result.main.change_class_samples);
    expect(serialized).not.toContain('A. Hearst');
    expect(result.main.change_class_samples.stored_is_roster_real_name).toEqual([7]);
  });

  it('leaves the class map empty for the message pass, which has no stored/recomputed pair', async () => {
    const opts = baseOpts();
    opts.loadMessagePage = pager<MessageRow>([
      [{ id: 1, entry_type: 'dj_join', message: 'A. Hearst joined the set!' }],
    ]);

    const result = await runScrub(opts);

    expect(result.message.changed).toBe(1);
    expect(result.message.by_change_class).toEqual({});
  });
});
