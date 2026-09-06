/**
 * Unit coverage for the two manager operations that have logic of their own
 * (BS#2362): `readStationSignupStatus`'s aggregation and
 * `approveSelfSignup`'s transaction. The other four routes are thin
 * delegations to `@wxyc/authentication` and are covered where that module is.
 *
 * `tests/integration/station-signup-admin.spec.js` is the main harness — it
 * drives the real endpoints against real Postgres, which is the only place a
 * WHERE predicate or a row lock can actually be proven. What a recording fake
 * adds on top is the pair of properties that are about the SHAPE of the calls
 * rather than their result, and that would otherwise only fail under a real
 * concurrent race:
 *
 *   1. the `auth_user` SELECT takes `FOR UPDATE` and does so BEFORE any
 *      `auth_member` write — the lock order `jobs/station-signup-review`'s
 *      `applyDowngrades` docstring makes mandatory, and which a refactor
 *      could silently invert without any single-threaded test noticing;
 *   2. `restoreDjRole` off issues NO `auth_member` write at all, rather than
 *      one that happens to match nothing.
 *
 * Everything shared with the `jest.mock` factories carries a `mock` prefix, as
 * the hoisting transform requires.
 */

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// --- Mocks ---

/** Fake columns. The assertions below check which column an operator was applied to, not rendered SQL. */
const mockUserTable = {
  id: { name: 'user.id' },
  name: { name: 'user.name' },
  djName: { name: 'user.djName' },
  selfSignupAt: { name: 'user.selfSignupAt' },
  selfSignupReviewedAt: { name: 'user.selfSignupReviewedAt' },
  selfSignupReviewedBy: { name: 'user.selfSignupReviewedBy' },
  selfSignupDowngradedAt: { name: 'user.selfSignupDowngradedAt' },
};
const mockMemberTable = {
  id: { name: 'member.id' },
  userId: { name: 'member.userId' },
  role: { name: 'member.role' },
};

type Table = typeof mockUserTable | typeof mockMemberTable;

/** Rows each fake query hands back, per scenario. */
interface Fixtures {
  selectUser: Record<string, unknown>[];
  selectMember: Record<string, unknown>[];
  updateUser: Record<string, unknown>[];
  updateMember: Record<string, unknown>[];
}

/** Every statement the fake saw, in order. This is what the lock-order assertion reads. */
interface RecordedOp {
  kind: 'select' | 'update';
  table: 'user' | 'member' | 'unknown';
  forUpdate?: boolean;
  values?: Record<string, unknown>;
  where?: unknown;
}

let mockFixtures: Fixtures;
let mockOps: RecordedOp[];

const mockNameOf = (table: Table): RecordedOp['table'] =>
  table === mockUserTable ? 'user' : table === mockMemberTable ? 'member' : 'unknown';

const mockMakeClient = () => ({
  select: (_projection: unknown) => ({
    from: (table: Table) => {
      let where: unknown;
      const rows = () => (table === mockUserTable ? mockFixtures.selectUser : mockFixtures.selectMember);
      const chain = {
        where: (predicate: unknown) => {
          where = predicate;
          return chain;
        },
        limit: (_n: number) => chain,
        for: (_strength: string) => {
          mockOps.push({ kind: 'select', table: mockNameOf(table), forUpdate: true, where });
          return Promise.resolve(rows());
        },
        // Drizzle's builders are thenable, so an un-`.for()`ed chain resolves
        // on await. Recording here rather than in from() is what keeps a
        // locking read distinguishable from a plain one.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          mockOps.push({ kind: 'select', table: mockNameOf(table), forUpdate: false, where });
          return Promise.resolve(rows()).then(resolve, reject);
        },
      };
      return chain;
    },
  }),
  update: (table: Table) => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: unknown) => ({
        returning: (_projection: unknown) => {
          mockOps.push({ kind: 'update', table: mockNameOf(table), values, where: predicate });
          return Promise.resolve(table === mockUserTable ? mockFixtures.updateUser : mockFixtures.updateMember);
        },
      }),
    }),
  }),
});

const mockTransaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockMakeClient()));

jest.mock('@wxyc/database', () => ({
  db: {
    select: (...args: unknown[]) => mockMakeClient().select(...(args as [unknown])),
    transaction: (...args: unknown[]) => mockTransaction(...(args as [(tx: unknown) => Promise<unknown>])),
  },
  user: mockUserTable,
  member: mockMemberTable,
}));

jest.mock('drizzle-orm', () => ({
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
}));

const mockReadStationPasscodeStates = jest.fn<() => Promise<unknown[]>>();
const mockEvaluateSignupCooldown = jest.fn<() => Promise<unknown>>();
const mockReadRecentSignupAttempts = jest.fn<() => Promise<Record<string, unknown>[]>>();
const mockCountSignupAttemptOutcomes = jest.fn<() => Promise<Record<string, number>>>();
const mockReadLastCooldownClearedAt = jest.fn<() => Promise<Date | null>>();

jest.mock('@wxyc/authentication', () => ({
  readStationPasscodeStates: (...args: unknown[]) => mockReadStationPasscodeStates(...(args as [])),
  evaluateSignupCooldown: (...args: unknown[]) => mockEvaluateSignupCooldown(...(args as [])),
  readRecentSignupAttempts: (...args: unknown[]) => mockReadRecentSignupAttempts(...(args as [])),
  countSignupAttemptOutcomes: (...args: unknown[]) => mockCountSignupAttemptOutcomes(...(args as [])),
  readLastCooldownClearedAt: (...args: unknown[]) => mockReadLastCooldownClearedAt(...(args as [])),
  // The module's real values. The status response divides the two durations
  // down to minutes, so stubbing round numbers here would let a
  // milliseconds-for-minutes mixup pass; these are pinned against the real
  // constants in tests/unit/authentication/station-passcode.test.ts.
  SIGNUP_COOLDOWN_WINDOW_MS: 10 * 60 * 1000,
  SIGNUP_COOLDOWN_HOLD_MS: 15 * 60 * 1000,
  SIGNUP_COOLDOWN_THRESHOLD: 20,
}));

// --- Import after mocks ---
import {
  approveSelfSignup,
  readStationSignupStatus,
  StationSignupAdminError,
} from '../../../apps/auth/station-signup-admin';

const NOW = new Date('2026-09-05T12:00:00.000Z');

/** Flatten a nested and()/eq() tree into a comparable list. */
type Clause = { op: string; parts?: Clause[]; col?: { name?: string }; val?: unknown };
const flatten = (clause: Clause): Clause[] => (clause.op === 'and' ? (clause.parts ?? []).flatMap(flatten) : [clause]);

beforeEach(() => {
  jest.clearAllMocks();
  mockOps = [];
  mockFixtures = { selectUser: [], selectMember: [], updateUser: [], updateMember: [] };
  mockReadStationPasscodeStates.mockResolvedValue([]);
  mockEvaluateSignupCooldown.mockResolvedValue({
    inCooldown: false,
    noMatchFailureCount: 0,
    allFailureCount: 0,
  });
  mockReadRecentSignupAttempts.mockResolvedValue([]);
  mockCountSignupAttemptOutcomes.mockResolvedValue({});
  mockReadLastCooldownClearedAt.mockResolvedValue(null);
});

describe('readStationSignupStatus', () => {
  const attempt = (overrides: Record<string, unknown>) => ({
    id: 'a1',
    attemptedAt: NOW,
    outcome: 'passcode_fail',
    passcodeId: null,
    actorUserId: null,
    ipHash: null,
    ...overrides,
  });

  it('counts the attempt log by outcome, leaving absent outcomes absent rather than zero', async () => {
    mockCountSignupAttemptOutcomes.mockResolvedValue({ passcode_fail: 2, passcode_ok: 1 });
    mockReadRecentSignupAttempts.mockResolvedValue([
      attempt({ id: 'a1', outcome: 'passcode_fail' }),
      attempt({ id: 'a2', outcome: 'passcode_fail' }),
      attempt({ id: 'a3', outcome: 'passcode_ok' }),
    ]);

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.attempts.countsByOutcome).toEqual({ passcode_fail: 2, passcode_ok: 1 });
    expect(status.attempts.countsByOutcome).not.toHaveProperty('passcode_revoked');
    expect(status.attempts.recent).toHaveLength(3);
    // Window-wide, from the same floor the display list uses.
    expect(mockCountSignupAttemptOutcomes).toHaveBeenCalledWith({ since: status.attempts.since });
  });

  // BS#2362 review, the blocking one. `recent` is `ORDER BY attempted_at DESC
  // LIMIT 100`, so counting ITS rows caps the TOTAL across every outcome at
  // 100 for a window documented as 24 hours — and lets this payload report
  // fewer 24-hour `passcode_fail` than the cooldown block's SQL count over
  // ten minutes.
  it('takes the counts from the SQL aggregate, NOT from the capped display list', async () => {
    mockCountSignupAttemptOutcomes.mockResolvedValue({ passcode_fail: 4312, cooldown_cleared: 1 });
    mockReadRecentSignupAttempts.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => attempt({ id: `a${i}`, outcome: 'passcode_fail' }))
    );

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.attempts.countsByOutcome).toEqual({ passcode_fail: 4312, cooldown_cleared: 1 });
    expect(status.attempts.recent).toHaveLength(100);
    // The one outcome the cap pushed out of the display list is still counted.
    expect(status.attempts.countsByOutcome.cooldown_cleared).toBe(1);
  });

  it('reports the cooldown rule in MINUTES, not milliseconds', async () => {
    mockEvaluateSignupCooldown.mockResolvedValue({
      inCooldown: true,
      noMatchFailureCount: 25,
      allFailureCount: 30,
    });

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.cooldown).toMatchObject({
      inCooldown: true,
      noMatchFailureCount: 25,
      allFailureCount: 30,
      windowMinutes: 10,
      holdMinutes: 15,
      threshold: 20,
    });
  });

  it('surfaces the most recent cooldown_cleared row, and null when there is none', async () => {
    const clearedAt = new Date('2026-09-05T11:30:00.000Z');
    mockReadLastCooldownClearedAt.mockResolvedValue(clearedAt);
    expect((await readStationSignupStatus({ now: NOW })).cooldown.lastClearedAt).toEqual(clearedAt);

    mockReadLastCooldownClearedAt.mockResolvedValue(null);
    expect((await readStationSignupStatus({ now: NOW })).cooldown.lastClearedAt).toBeNull();
  });

  // The other half of the blocking finding: derived from `recent`,
  // lastClearedAt reverted to null the moment 100 attempts landed after the
  // clear — during a cooldown_refused storm that is a couple of minutes, and
  // it is exactly when a manager is polling to confirm the clear took.
  it('reads the clear from the dedicated floor query, not from the capped display list', async () => {
    const clearedAt = new Date('2026-09-05T11:30:00.000Z');
    mockReadLastCooldownClearedAt.mockResolvedValue(clearedAt);
    // A full display list, every row a refusal — the clear has been pushed
    // out of it entirely.
    mockReadRecentSignupAttempts.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => attempt({ id: `a${i}`, outcome: 'cooldown_refused' }))
    );

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.cooldown.lastClearedAt).toEqual(clearedAt);
    expect(status.attempts.recent.some((row) => row.outcome === 'cooldown_cleared')).toBe(false);
  });

  it('floors days-pending and lists the longest-waiting account first', async () => {
    mockFixtures.selectUser = [
      {
        userId: 'u-new',
        name: 'New',
        djName: null,
        // 2 days and 23 hours -- floors to 2, never rounds up to 3.
        selfSignupAt: new Date(NOW.getTime() - (2 * 24 + 23) * 60 * 60 * 1000),
        selfSignupDowngradedAt: null,
      },
      {
        userId: 'u-old',
        name: 'Old',
        djName: 'DJ Old',
        selfSignupAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
        selfSignupDowngradedAt: new Date('2026-09-04T00:00:00.000Z'),
      },
    ];

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.pendingReview.map((row) => row.userId)).toEqual(['u-old', 'u-new']);
    expect(status.pendingReview[0]).toMatchObject({ daysPending: 31, djName: 'DJ Old' });
    expect(status.pendingReview[0].selfSignupDowngradedAt).toEqual(new Date('2026-09-04T00:00:00.000Z'));
    expect(status.pendingReview[1]).toMatchObject({ daysPending: 2, selfSignupDowngradedAt: null });
  });

  it('reads the pending cohort by self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL', async () => {
    await readStationSignupStatus({ now: NOW });

    const cohortRead = mockOps.find((op) => op.kind === 'select' && op.table === 'user');
    expect(cohortRead).toBeDefined();
    const clauses = flatten(cohortRead?.where as Clause);
    expect(clauses).toContainEqual({ op: 'isNotNull', col: mockUserTable.selfSignupAt });
    expect(clauses).toContainEqual({ op: 'isNull', col: mockUserTable.selfSignupReviewedAt });
    // NOT narrowed by self_signup_downgraded_at: an account the actuator
    // already downgraded must keep appearing until a human reviews it.
    expect(clauses.some((clause) => clause.col === mockUserTable.selfSignupDowngradedAt)).toBe(false);
  });

  it('writes nothing at all, which is what makes it safe to poll', async () => {
    mockFixtures.selectUser = [
      { userId: 'u1', name: 'A', djName: null, selfSignupAt: NOW, selfSignupDowngradedAt: null },
    ];

    await readStationSignupStatus({ now: NOW });

    expect(mockOps.every((op) => op.kind === 'select')).toBe(true);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('never carries plaintext — the passcode block is exactly the never-decrypting view', async () => {
    const stateRows = [{ id: 'p1', state: 'active', useCount: 1, maxUses: 50 }];
    mockReadStationPasscodeStates.mockResolvedValue(stateRows);

    const status = await readStationSignupStatus({ now: NOW });

    expect(status.passcodes).toEqual(stateRows);
    expect(JSON.stringify(status)).not.toMatch(/"code"|codeEncrypted/);
  });
});

describe('approveSelfSignup', () => {
  const pendingAccount = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    selfSignupAt: new Date('2026-08-01T00:00:00.000Z'),
    selfSignupReviewedAt: null,
    selfSignupReviewedBy: null,
    selfSignupDowngradedAt: null,
    ...overrides,
  });

  const approve = (params: Record<string, unknown> = {}) =>
    approveSelfSignup({ userId: 'u1', reviewerId: 'manager-1', now: NOW, ...params });

  it('404s on an unknown user without writing anything', async () => {
    mockFixtures.selectUser = [];

    await expect(approve()).rejects.toBeInstanceOf(StationSignupAdminError);
    await expect(approve()).rejects.toMatchObject({ statusCode: 404 });
    expect(mockOps.some((op) => op.kind === 'update')).toBe(false);
  });

  it('409s on an account that never self-signed up, so the review columns stay meaningless there', async () => {
    mockFixtures.selectUser = [pendingAccount({ selfSignupAt: null })];

    await expect(approve()).rejects.toMatchObject({ statusCode: 409 });
    expect(mockOps.some((op) => op.kind === 'update')).toBe(false);
  });

  it('stamps reviewed_at/_by from the reviewerId it was handed, and preserves the downgrade marker', async () => {
    const downgradedAt = new Date('2026-09-01T00:00:00.000Z');
    mockFixtures.selectUser = [pendingAccount({ selfSignupDowngradedAt: downgradedAt })];
    mockFixtures.updateUser = [{ id: 'u1' }];
    mockFixtures.selectMember = [{ role: 'member' }];

    const result = await approve();

    expect(result).toMatchObject({
      userId: 'u1',
      reviewedAt: NOW,
      reviewedBy: 'manager-1',
      reviewedByThisCall: true,
      roleRestored: false,
      memberRole: 'member',
    });
    // Approval is not a history edit: the marker records what happened.
    expect(result.selfSignupDowngradedAt).toEqual(downgradedAt);
    const stamp = mockOps.find((op) => op.kind === 'update' && op.table === 'user');
    expect(stamp?.values).toEqual({ selfSignupReviewedAt: NOW, selfSignupReviewedBy: 'manager-1' });
    // The stamp is guarded IS NULL, which is what makes it write-once.
    expect(flatten(stamp?.where as Clause)).toContainEqual({
      op: 'isNull',
      col: mockUserTable.selfSignupReviewedAt,
    });
  });

  it('is write-once: a second approval reports the ORIGINAL reviewer, not the second caller', async () => {
    const firstReviewAt = new Date('2026-09-02T00:00:00.000Z');
    mockFixtures.selectUser = [
      pendingAccount({ selfSignupReviewedAt: firstReviewAt, selfSignupReviewedBy: 'manager-first' }),
    ];
    // The IS NULL guard matched nothing.
    mockFixtures.updateUser = [];
    mockFixtures.selectMember = [{ role: 'dj' }];

    const result = await approve({ reviewerId: 'manager-second' });

    expect(result).toMatchObject({
      reviewedAt: firstReviewAt,
      reviewedBy: 'manager-first',
      reviewedByThisCall: false,
    });
  });

  it('still applies restoreDjRole on that second call, so a re-promotion is not a dead end', async () => {
    mockFixtures.selectUser = [
      pendingAccount({
        selfSignupReviewedAt: new Date('2026-09-02T00:00:00.000Z'),
        selfSignupReviewedBy: 'manager-first',
      }),
    ];
    mockFixtures.updateUser = [];
    mockFixtures.updateMember = [{ id: 'm1' }];
    mockFixtures.selectMember = [{ role: 'dj' }];

    const result = await approve({ restoreDjRole: true });

    expect(result).toMatchObject({ reviewedByThisCall: false, roleRestored: true, memberRole: 'dj' });
  });

  it('issues NO auth_member write at all without restoreDjRole', async () => {
    mockFixtures.selectUser = [pendingAccount({ selfSignupDowngradedAt: new Date('2026-09-01T00:00:00.000Z') })];
    mockFixtures.updateUser = [{ id: 'u1' }];
    mockFixtures.selectMember = [{ role: 'member' }];

    const result = await approve();

    // The quiet default has to be "grant nothing" — a manager may well decide
    // the person should not be a DJ.
    expect(mockOps.some((op) => op.kind === 'update' && op.table === 'member')).toBe(false);
    expect(result.roleRestored).toBe(false);
  });

  it("can only ever set 'dj', and only from 'member' — never a demotion of a higher role", async () => {
    mockFixtures.selectUser = [pendingAccount()];
    mockFixtures.updateUser = [{ id: 'u1' }];
    // A musicDirector matched nothing: the WHERE pinned the source role.
    mockFixtures.updateMember = [];
    mockFixtures.selectMember = [{ role: 'musicDirector' }];

    const result = await approve({ restoreDjRole: true });

    const roleWrite = mockOps.find((op) => op.kind === 'update' && op.table === 'member');
    expect(roleWrite?.values).toEqual({ role: 'dj' });
    expect(flatten(roleWrite?.where as Clause)).toContainEqual({
      op: 'eq',
      col: mockMemberTable.role,
      val: 'member',
    });
    expect(result).toMatchObject({ roleRestored: false, memberRole: 'musicDirector' });
  });

  it('locks auth_user FOR UPDATE first, BEFORE any auth_member write, all in ONE transaction', async () => {
    mockFixtures.selectUser = [pendingAccount()];
    mockFixtures.updateUser = [{ id: 'u1' }];
    mockFixtures.updateMember = [{ id: 'm1' }];
    mockFixtures.selectMember = [{ role: 'dj' }];

    await approve({ restoreDjRole: true });

    // The order jobs/station-signup-review/downgrade.ts's applyDowngrades
    // makes mandatory. Taking these the other way round deadlocks the pair,
    // and the job's loser lands in `failed` rather than in benign `raced`.
    expect(mockOps[0]).toMatchObject({ kind: 'select', table: 'user', forUpdate: true });
    expect(mockOps.findIndex((op) => op.kind === 'update' && op.table === 'member')).toBeGreaterThan(0);
    // One transaction, so the stamp and the role flip cannot half-apply.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * The route wiring in `apps/auth/app.ts`, asserted against its source text.
 *
 * Importing that module starts a server and pulls in better-auth, so the
 * express app itself is out of reach of this tier — the same reason
 * `tests/unit/auth/rate-limiting.test.ts` pins its limiters this way. The
 * integration suite proves the gate REJECTS (401/403 on all six routes); what
 * it cannot show is that the gate is mounted structurally rather than by
 * convention, or that a branch only an unconfigured deployment can reach
 * exists at all — CI always has STATION_PASSCODE_KEY set.
 */
describe('station-signup admin route wiring (app.ts source)', () => {
  const appSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');

  it('mounts the admin-flag gate ONCE on the router, so a new route cannot skip it', () => {
    expect(appSource).toMatch(/const stationSignupAdminRouter = express\.Router\(\);/);
    expect(appSource).toMatch(/stationSignupAdminRouter\.use\(stationSignupAdminGate\);/);
    expect(appSource).toMatch(/app\.use\(STATION_SIGNUP_ADMIN_PREFIX, stationSignupAdminRouter\);/);
  });

  it('keeps the six paths on the same prefix they shipped with', () => {
    expect(appSource).toMatch(/const STATION_SIGNUP_ADMIN_PREFIX = '\/auth\/admin\/station-signup';/);
    for (const route of ['/reveal', '/rotate', '/revoke', '/clear-cooldown', '/status', '/approve']) {
      expect(appSource).toContain(`stationSignupAdminRouter.${route === '/status' ? 'get' : 'post'}(\n  '${route}',`);
    }
  });

  it('maps StationPasscodeKeyUnsetError to 503 passcode_key_unset, distinct from the decrypt branch', () => {
    expect(appSource).toMatch(/error instanceof StationPasscodeKeyUnsetError/);
    expect(appSource).toMatch(/code: 'passcode_key_unset'/);
    // The two 503s must stay distinguishable: the decrypt one's remedy is
    // STATION_PASSCODE_KEY_PREVIOUS, which cannot fix a missing current key.
    expect(appSource).toMatch(/code: 'passcode_undecryptable'/);
    expect(appSource.indexOf("code: 'passcode_key_unset'")).toBeLessThan(
      appSource.indexOf("code: 'passcode_undecryptable'")
    );
  });
});
