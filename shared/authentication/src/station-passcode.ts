/**
 * Station self-signup passcode lifecycle (BS#2359): generation, encryption,
 * verification, rotation, revocation, cooldown evaluation, and the attempt
 * log. Four downstream issues (#2361-#2364) consume this module's exported
 * surface, so the shape settled here is load-bearing — see the issue body
 * and its pinned comment before changing any of it.
 *
 * THREAT MODEL — this is the repo's first encryption-at-rest code.
 *
 * The code is AES-256-GCM encrypted, never hashed, because it is meant to be
 * READ BACK: a stationManager reveals the current code and reads it to a
 * stranded DJ by phone, without rotating (rotating under the two-row cap can
 * invalidate the note everyone else in the room is using).
 *
 * `STATION_PASSCODE_KEY` ships to the EC2 host's `.env` alongside
 * `DB_PASSWORD`. Encryption protects a leaked dump or RDS snapshot — the
 * ciphertext is worthless without the key, which never leaves the host. It
 * does NOT protect against host compromise, where an attacker has both
 * halves. Worth having (a dump outlives and travels further than host
 * access) but not the broader guarantee the phrase usually implies.
 *
 * Key rotation is free and needs no re-encryption: rows live <=14 days and
 * there are at most two, so operationally "rotate the key" just means "set
 * a new STATION_PASSCODE_KEY and call rotateStationPasscode" — old
 * ciphertext becomes undecryptable garbage, which is fine, it was going to
 * expire anyway. That is also why this module treats an ACTIVE row's
 * decrypt failure and an INACTIVE row's decrypt failure completely
 * differently (see classifyInactiveStationPasscode below): the same event
 * (a key rotation) is a gate-integrity emergency for a row that is supposed
 * to be a live credential right now, and routine cleanup for a row that
 * expired weeks ago.
 *
 * Everything here is designed against the epic #2365 availability
 * constraint: every control fails toward "wait a few minutes", never
 * toward locking the control room out. That is why the cooldown never
 * revokes anything, why it excludes stale-code failures from the refusal
 * count (see evaluateSignupCooldown), and why a misconfigured
 * STATION_SIGNUP_IP_HMAC_KEY degrades the audit trail instead of the gate
 * (see deriveStationSignupIpHash).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { isIP } from 'net';
import { and, asc, desc, eq, gt, gte, inArray, isNull, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { db, station_passcode, station_signup_attempt } from '@wxyc/database';

// ---------------------------------------------------------------------------
// Outcome vocabulary (settled in the issue's pinned comment). A TypeScript
// union, not a DB CHECK: the table has exactly one writer (this module) by
// design, so a CHECK would cost a migration now and another on every future
// token for no correctness this union doesn't already buy at compile time.
// ---------------------------------------------------------------------------

export const STATION_SIGNUP_OUTCOMES = [
  'passcode_ok',
  'passcode_fail',
  'passcode_expired',
  'passcode_revoked',
  'passcode_exhausted',
  'cooldown_refused',
  'cooldown_cleared',
  'passcode_revealed',
] as const;

export type StationSignupOutcome = (typeof STATION_SIGNUP_OUTCOMES)[number];

// Feeds the digest alert (BS#2364). All four "a code was involved and it
// didn't work" outcomes — deliberately excludes cooldown_refused/cleared
// (not failures against a code) and passcode_ok/passcode_revealed (not
// failures at all).
const ALERT_OUTCOMES: ReadonlySet<StationSignupOutcome> = new Set([
  'passcode_fail',
  'passcode_expired',
  'passcode_revoked',
  'passcode_exhausted',
]);

// Feeds refusal (the cooldown trigger). ONLY genuine no-match failures — see
// the module header and evaluateSignupCooldown for why passcode_expired /
// passcode_revoked / passcode_exhausted must never join this set.
const REFUSAL_OUTCOME: StationSignupOutcome = 'passcode_fail';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** At most two station passcodes may be active at once. See rotateStationPasscode. */
export const STATION_PASSCODE_MAX_ACTIVE = 2;

/** Default passcode lifetime: rows live <=14 days (module header). */
export const STATION_PASSCODE_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Mirrors station_passcode.max_uses's own column default (schema.ts). */
export const STATION_PASSCODE_DEFAULT_MAX_USES = 25;

/**
 * Rotation's advisory-lock key. Station-global (not per-passcode) because
 * the two-row cap counts rows matching a predicate, and the row being
 * inserted does not exist yet — there is nothing per-row to lock. See the
 * issue body's "Rotation and the two-row cap" section for the full argument
 * against `SELECT ... FOR UPDATE` as a substitute.
 *
 * MUST stay distinct from the two other advisory locks in this codebase:
 * `jobs/legacy-mirror-reconcile/job.ts`'s `ADVISORY_LOCK_KEY = 17071707` and
 * `apps/backend/routes/internal-slack-moderators.route.ts`'s
 * `SLACK_MODERATORS_ADVISORY_LOCK_KEY = 20260808`. `pg_try_advisory_lock`
 * and `pg_advisory_xact_lock` share one lock space database-wide, so
 * reusing either number would serialize passcode rotation behind an
 * unrelated cron or roster save. Value is this key's allocation date.
 */
export const STATION_PASSCODE_ROTATE_ADVISORY_LOCK_KEY = 20260905;

/** Cooldown detection window: "more than 20 in 10 minutes" (issue body). */
export const SIGNUP_COOLDOWN_WINDOW_MS = 10 * 60 * 1000;

/** Cooldown hold duration once triggered. */
export const SIGNUP_COOLDOWN_HOLD_MS = 15 * 60 * 1000;

/** Refusal triggers on MORE than this many no-match failures in the window. */
export const SIGNUP_COOLDOWN_THRESHOLD = 20;

/**
 * Classification lookback for recently-inactive rows (expired/revoked),
 * matching the 30-day audit horizon pruneSignupAttempts assumes. Bounded
 * because nothing prunes station_passcode itself — an unbounded scan would
 * grow forever.
 */
export const STATION_PASSCODE_CLASSIFICATION_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** Default retention for pruneSignupAttempts — the 30-day audit window. */
export const STATION_SIGNUP_ATTEMPT_DEFAULT_RETENTION_DAYS = 30;

// 32-character unambiguous alphabet: digits 2-9 (excludes 0/1) plus A-Z
// excluding I/O (excludes the two letters most easily confused with 1 and
// 0). Still legible on a sticky note read aloud over the phone. A generated
// code never contains a lowercase letter, so the "1/l/I" ambiguity in the
// issue body collapses to just excluding uppercase I here.
const PASSCODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSCODE_LENGTH = 8;

const PASSCODE_CIPHER_ALGORITHM = 'aes-256-gcm';
const PASSCODE_IV_LENGTH = 12;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when decrypting an ACTIVE station_passcode row fails. Fails closed
 * by design: verifyStationPasscode/revealStationPasscode/rotateStationPasscode
 * (in the read-back path) must never fall through to "no match", which would
 * make a misconfigured/rotated key look identical to a run of wrong guesses
 * and silently disable the gate with no loud error anywhere (module header).
 */
export class StationPasscodeDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StationPasscodeDecryptionError';
  }
}

/** Thrown by rotateStationPasscode when two passcodes are already active. */
export class StationPasscodeCapExceededError extends Error {
  constructor() {
    super(
      `Cannot rotate: ${STATION_PASSCODE_MAX_ACTIVE} station passcodes are already active. Revoke one before rotating another.`
    );
    this.name = 'StationPasscodeCapExceededError';
  }
}

// ---------------------------------------------------------------------------
// Encryption (pure — exported for the unit round-trip/wrong-key tests)
// ---------------------------------------------------------------------------

/**
 * Resolved lazily on every call (never at module import), so importing this
 * module never crashes a process that hasn't set STATION_PASSCODE_KEY yet —
 * e.g. any unit test that pulls in the `@wxyc/authentication` barrel for an
 * unrelated symbol.
 */
function resolveStationPasscodeKey(): Buffer {
  const raw = process.env.STATION_PASSCODE_KEY;
  if (!raw) throw new Error('STATION_PASSCODE_KEY is not set');
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error(`STATION_PASSCODE_KEY must decode to 32 bytes (64 hex characters); got ${key.length} byte(s)`);
  }
  return key;
}

/** `iv:tag:ciphertext`, each base64 — one column, AES-256-GCM. */
export function encryptStationPasscodeValue(plaintext: string, key: Buffer = resolveStationPasscodeKey()): string {
  const iv = randomBytes(PASSCODE_IV_LENGTH);
  const cipher = createCipheriv(PASSCODE_CIPHER_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((buf) => buf.toString('base64')).join(':');
}

/**
 * Inverse of encryptStationPasscodeValue. Throws on a wrong key or corrupt
 * ciphertext — GCM's auth tag check fails in `decipher.final()` — which is
 * exactly the fail-closed behavior active-row callers below depend on.
 */
export function decryptStationPasscodeValue(stored: string, key: Buffer = resolveStationPasscodeKey()): string {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Malformed station passcode ciphertext (expected iv:tag:ciphertext)');
  const [ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(PASSCODE_CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Pure alphabet draw via `randomInt` (unbiased, unlike `randomBytes() % n`). */
export function generatePasscodeCode(length: number = PASSCODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSCODE_ALPHABET[randomInt(PASSCODE_ALPHABET.length)];
  }
  return out;
}

export interface GeneratedStationPasscode {
  code: string;
  codeEncrypted: string;
}

/**
 * Generate a fresh code and its encrypted-at-rest form. Pure (no DB) — the
 * DB-touching half of "generate a new passcode" is rotateStationPasscode,
 * which calls this and then persists the result under the advisory lock.
 * Generated, never manager-chosen: a manager-typed code would be "wxyc2026".
 */
export function generateStationPasscode(): GeneratedStationPasscode {
  const code = generatePasscodeCode();
  const codeEncrypted = encryptStationPasscodeValue(code);
  return { code, codeEncrypted };
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Hash both sides to a fixed-length digest before `timingSafeEqual`, so an
 * attacker-controlled length (the submitted code) can never throw a length
 * mismatch and never influences comparison time — `timingSafeEqual` itself
 * requires equal-length buffers, which two different-length raw strings
 * would violate.
 */
export function constantTimeStringsEqual(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a, 'utf8').digest();
  const bHash = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Compare a submitted code against every decrypted active row with NO early
 * exit: the loop never returns/breaks mid-iteration, so the total work done
 * (including each row's comparison) is identical whether the match is the
 * first row, the last row, or absent — returning on first match would leak,
 * through response timing, which of the two active codes was used.
 */
export function findActivePasscodeMatch(
  rows: ReadonlyArray<{ id: string; decryptedCode: string }>,
  submittedCode: string,
  compare: (a: string, b: string) => boolean = constantTimeStringsEqual
): string | null {
  let matchedId: string | null = null;
  for (const row of rows) {
    const isMatch = compare(row.decryptedCode, submittedCode);
    matchedId = isMatch ? row.id : matchedId;
  }
  return matchedId;
}

// ---------------------------------------------------------------------------
// station_passcode predicates
// ---------------------------------------------------------------------------

/**
 * Pure mirror of activePasscodePredicate's SQL, for the unit suite: a row is
 * active iff it hasn't been revoked and its expiry is still in the future.
 * Keep these two in sync by hand — one is JS boolean logic, the other a SQL
 * WHERE clause, and there is no single source both could share.
 */
export function isStationPasscodeActive(row: { revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return row.revokedAt === null && row.expiresAt.getTime() > now.getTime();
}

function activePasscodePredicate(now: Date) {
  return and(isNull(station_passcode.revokedAt), gt(station_passcode.expiresAt, now));
}

/**
 * Pure mirror of recentlyInactivePasscodePredicate's SQL — see
 * isStationPasscodeActive for why these two are kept separately.
 */
export function isStationPasscodeRecentlyInactive(
  row: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
  since: Date
): boolean {
  const inactive = row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime();
  if (!inactive) return false;
  const recentlyRevoked = row.revokedAt !== null && row.revokedAt.getTime() >= since.getTime();
  const recentlyExpired = row.expiresAt.getTime() >= since.getTime();
  return recentlyRevoked || recentlyExpired;
}

/**
 * Rows that are NOT active (revoked, or past expiry) but became inactive
 * within STATION_PASSCODE_CLASSIFICATION_HORIZON_MS — the bounded scan
 * classifyInactiveStationPasscode needs, since nothing prunes this table.
 */
function recentlyInactivePasscodePredicate(now: Date, since: Date) {
  return and(
    or(isNotNull(station_passcode.revokedAt), lte(station_passcode.expiresAt, now)),
    or(gte(station_passcode.revokedAt, since), gte(station_passcode.expiresAt, since))
  );
}

// ---------------------------------------------------------------------------
// ip_hash derivation (BS#2359 per the schema.ts column comment — read that
// comment for the full specification; this is the implementation, not a
// second copy of the spec).
// ---------------------------------------------------------------------------

let warnedMissingIpHmacKey = false;

function resolveSignupIpHmacKey(): Buffer | null {
  const raw = process.env.STATION_SIGNUP_IP_HMAC_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) return null;
  return key;
}

/** Trim, lowercase, and collapse an IPv4-mapped IPv6 address to its dotted quad. */
export function canonicalizeStationSignupClientIp(rawClientIp: string | undefined): string | null {
  if (!rawClientIp) return null;
  let value = rawClientIp.trim().toLowerCase();
  const v4MappedPrefix = '::ffff:';
  if (value.startsWith(v4MappedPrefix)) value = value.slice(v4MappedPrefix.length);
  if (!value || isIP(value) === 0) return null;
  return value;
}

/**
 * KEYED hash of the canonical client IP for the audit-only `ip_hash` column.
 * See the column comment in shared/database/src/schema.ts for the full
 * specification (which header, canonicalization, key encoding).
 *
 * The DERIVATION fails closed (never an unkeyed digest — see the schema
 * comment on why that would be worthless). The REQUEST does not: a missing
 * key, absent header, or invalid IP returns null and the signup proceeds —
 * refusing a walk-in DJ over an audit-only column is exactly the outage
 * #2365 forbids. A misconfigured key is logged once per process (not once
 * per request) so a production misconfiguration is discoverable without
 * flooding the logs.
 */
export function deriveStationSignupIpHash(rawClientIp: string | undefined): string | null {
  const key = resolveSignupIpHmacKey();
  if (!key) {
    if (!warnedMissingIpHmacKey) {
      warnedMissingIpHmacKey = true;
      console.error(
        '[station-passcode] STATION_SIGNUP_IP_HMAC_KEY is missing or not 64 hex characters; ip_hash will be ' +
          'recorded as NULL on every signup attempt until it is set. The signup gate itself is unaffected — see ' +
          'the ip_hash column comment in shared/database/src/schema.ts.'
      );
    }
    return null;
  }
  const canonical = canonicalizeStationSignupClientIp(rawClientIp);
  if (!canonical) return null;
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Attempt log
// ---------------------------------------------------------------------------

interface InsertSignupAttemptParams {
  outcome: StationSignupOutcome;
  passcodeId?: string | null;
  actorUserId?: string | null;
  ipHash?: string | null;
  attemptedAt: Date;
}

async function insertSignupAttempt(params: InsertSignupAttemptParams): Promise<void> {
  await db.insert(station_signup_attempt).values({
    id: randomUUID(),
    attemptedAt: params.attemptedAt,
    outcome: params.outcome,
    passcodeId: params.passcodeId ?? null,
    actorUserId: params.actorUserId ?? null,
    ipHash: params.ipHash ?? null,
  });
}

export interface ReadRecentSignupAttemptsOptions {
  limit?: number;
  since?: Date;
}

/** For the admin API (#2362) to display recent attempts. */
export async function readRecentSignupAttempts(options: ReadRecentSignupAttemptsOptions = {}) {
  const { limit = 100, since = new Date(0) } = options;
  return db
    .select()
    .from(station_signup_attempt)
    .where(gte(station_signup_attempt.attemptedAt, since))
    .orderBy(desc(station_signup_attempt.attemptedAt))
    .limit(limit);
}

export interface PruneSignupAttemptsOptions {
  olderThanDays?: number;
  now?: Date;
}

/**
 * Delete attempt rows older than the retention window (default 30 days —
 * the audit horizon). Never touches station_passcode. Run from a job, not
 * the request path.
 */
export async function pruneSignupAttempts(options: PruneSignupAttemptsOptions = {}): Promise<number> {
  const { olderThanDays = STATION_SIGNUP_ATTEMPT_DEFAULT_RETENTION_DAYS, now = new Date() } = options;
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(station_signup_attempt)
    .where(lt(station_signup_attempt.attemptedAt, cutoff))
    .returning({ id: station_signup_attempt.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

export interface SignupCooldownEvaluation {
  inCooldown: boolean;
  /** In-window count of genuine no-match failures — feeds refusal. */
  noMatchFailureCount: number;
  /** In-window count of every failure outcome — feeds the digest alert. */
  allFailureCount: number;
}

/**
 * Pure arithmetic over an already-fetched, already-failure-filtered row set
 * (outcome restricted to ALERT_OUTCOMES by the caller). Exported so the unit
 * suite can exercise the trigger/hold/clear-floor math without a database —
 * see the module docs on why `jest.unit.config.ts`'s DB mock can't prove
 * anything about this arithmetic itself.
 *
 * Self-healing without stored state: a cooldown is "in effect at `now`" iff
 * some no-match failure row R, no older than SIGNUP_COOLDOWN_HOLD_MS, had
 * more than SIGNUP_COOLDOWN_THRESHOLD no-match failures in the
 * SIGNUP_COOLDOWN_WINDOW_MS trailing it. Once a burst crosses the
 * threshold, every failure inside it also independently re-qualifies (its
 * own trailing window is at least as full), so the hold naturally extends
 * for as long as failures keep arriving and decays on its own
 * SIGNUP_COOLDOWN_HOLD_MS after the last one — no "cooldown active" flag to
 * clear, and cooldown_refused rows (which don't count as failures) can
 * never re-trigger it by themselves.
 */
export function computeSignupCooldownState(
  rows: ReadonlyArray<{ outcome: string; attemptedAt: Date }>,
  now: Date
): SignupCooldownEvaluation {
  const windowStart = new Date(now.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);
  const noMatchFailures = rows.filter((r) => r.outcome === REFUSAL_OUTCOME);

  const noMatchFailureCount = noMatchFailures.filter((r) => r.attemptedAt >= windowStart).length;
  const allFailureCount = rows.filter((r) => r.attemptedAt >= windowStart).length;

  let inCooldown = false;
  for (const row of noMatchFailures) {
    if (now.getTime() - row.attemptedAt.getTime() >= SIGNUP_COOLDOWN_HOLD_MS) continue;
    const trailingFloor = new Date(row.attemptedAt.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);
    const trailingCount = noMatchFailures.filter(
      (r) => r.attemptedAt > trailingFloor && r.attemptedAt <= row.attemptedAt
    ).length;
    if (trailingCount > SIGNUP_COOLDOWN_THRESHOLD) {
      inCooldown = true;
      break;
    }
  }

  return { inCooldown, noMatchFailureCount, allFailureCount };
}

/**
 * The DB-query floor for evaluateSignupCooldown: the later of (a) the most
 * recent `cooldown_cleared` row's timestamp — a manager's clear is a floor
 * on the window, never a deletion, see clearSignupCooldown — and (b) a
 * fixed lookback of window+hold, since nothing older than that can still
 * affect either the returned counts (bounded to the window) or the
 * trigger/hold check (bounded to the hold). Pure, exported for the unit
 * suite's "clear-as-window-floor" test.
 */
export function resolveCooldownLookbackStart(now: Date, clearedAt: Date | null): Date {
  const lookbackStart = new Date(now.getTime() - (SIGNUP_COOLDOWN_WINDOW_MS + SIGNUP_COOLDOWN_HOLD_MS));
  return clearedAt && clearedAt.getTime() > lookbackStart.getTime() ? clearedAt : lookbackStart;
}

/**
 * Evaluate the station-global signup cooldown. Read-only — safe to call on
 * every poll of a status endpoint (#2362) without side effects.
 *
 * Two outcome-first queries (matching the composite (outcome, attempted_at)
 * index — see the table's header comment in schema.ts): the most recent
 * `cooldown_cleared` row, then every failure-outcome row at or after
 * resolveCooldownLookbackStart's floor.
 */
export async function evaluateSignupCooldown(now: Date = new Date()): Promise<SignupCooldownEvaluation> {
  const [clearedRow] = await db
    .select({ attemptedAt: station_signup_attempt.attemptedAt })
    .from(station_signup_attempt)
    .where(eq(station_signup_attempt.outcome, 'cooldown_cleared'))
    .orderBy(desc(station_signup_attempt.attemptedAt))
    .limit(1);
  const clearedAt = clearedRow?.attemptedAt ?? null;
  const effectiveStart = resolveCooldownLookbackStart(now, clearedAt);

  const rows = await db
    .select({ outcome: station_signup_attempt.outcome, attemptedAt: station_signup_attempt.attemptedAt })
    .from(station_signup_attempt)
    .where(
      and(
        inArray(station_signup_attempt.outcome, [...ALERT_OUTCOMES]),
        gte(station_signup_attempt.attemptedAt, effectiveStart)
      )
    )
    .orderBy(asc(station_signup_attempt.attemptedAt));

  return computeSignupCooldownState(rows, now);
}

/**
 * A manager clears the cooldown. Writes a `cooldown_cleared` row — never
 * deletes anything, since the attempt log is both the cooldown's own input
 * and the 30-day audit trail pruneSignupAttempts assumes exists. Evaluation
 * counts failures only at or after this row: the clear is a floor on the
 * window, not a rewrite of history.
 */
export async function clearSignupCooldown(actorUserId: string, now: Date = new Date()): Promise<void> {
  await insertSignupAttempt({ outcome: 'cooldown_cleared', actorUserId, attemptedAt: now });
}

// ---------------------------------------------------------------------------
// Classification of a failed match against recently-inactive rows
// ---------------------------------------------------------------------------

interface InactiveClassification {
  outcome: Extract<StationSignupOutcome, 'passcode_fail' | 'passcode_expired' | 'passcode_revoked'>;
  passcodeId: string | null;
}

/**
 * Verification already failed against every ACTIVE row. Before logging a
 * bare `passcode_fail`, check whether the code matches a row that recently
 * stopped being active — a stale sticky note, not a guess — so the digest
 * alert (#2364) can tell the two apart.
 *
 * Two decrypt-failure policies, DIFFERENT from the active-row path:
 * decrypting an inactive row is silently skipped on failure, never fail
 * closed. After a key rotation, every row from before the rotation is
 * undecryptable by design, and fail-closed here would throw on every
 * classification for the whole 30-day horizon — breaking the endpoint
 * entirely, not just degrading its audit trail.
 *
 * Not constant-time: unlike the active-row match, an early return here
 * costs nothing an attacker can use (the client response stays generic
 * regardless — see verifyStationPasscode), and there is no live credential
 * whose comparison is worth spending on a code already known to be no
 * longer valid.
 */
async function classifyInactiveStationPasscode(code: string, now: Date): Promise<InactiveClassification> {
  const since = new Date(now.getTime() - STATION_PASSCODE_CLASSIFICATION_HORIZON_MS);
  const rows = await db.select().from(station_passcode).where(recentlyInactivePasscodePredicate(now, since));

  for (const row of rows) {
    let plaintext: string;
    try {
      plaintext = decryptStationPasscodeValue(row.codeEncrypted);
    } catch {
      continue;
    }
    if (constantTimeStringsEqual(plaintext, code)) {
      return { outcome: row.revokedAt ? 'passcode_revoked' : 'passcode_expired', passcodeId: row.id };
    }
  }
  return { outcome: 'passcode_fail', passcodeId: null };
}

// ---------------------------------------------------------------------------
// Verification (+ implicit cooldown gate, + the use-claim)
// ---------------------------------------------------------------------------

export interface VerifyStationPasscodeOptions {
  /** The X-Real-IP header value, if any — see deriveStationSignupIpHash. */
  rawClientIp?: string;
  now?: Date;
}

export interface VerifyStationPasscodeResult {
  ok: boolean;
  /**
   * True when this attempt was refused by the cooldown without ever
   * touching a passcode row. Safe to surface to the caller (unlike the
   * outcome classification below) — it reveals nothing about passcode
   * validity, only that the station-wide gate is temporarily closed, which
   * is the "wait a few minutes" signal #2365 wants the endpoint to give.
   */
  cooldown: boolean;
}

/**
 * Verify a submitted code and, on a genuine match, claim one use.
 *
 * Ordering, per the issue body: the cooldown check runs BEFORE
 * verification (a refusal must never decrypt anything or touch a passcode
 * row), and any caller-side validation unrelated to which passcode row
 * matched (e.g. #2361's username checks) must run before calling this
 * function at all — the use-claim below must never fire for a request that
 * is going to be rejected for an unrelated reason, or a fumbled username
 * burns a real code's limited uses.
 *
 * The classification split (passcode_fail vs. _expired/_revoked/_exhausted)
 * lives ONLY in the attempt log. The return value here stays generic on
 * purpose — see the outcome vocabulary table in the issue body.
 */
export async function verifyStationPasscode(
  code: string,
  options: VerifyStationPasscodeOptions = {}
): Promise<VerifyStationPasscodeResult> {
  const now = options.now ?? new Date();
  const ipHash = deriveStationSignupIpHash(options.rawClientIp);

  const cooldown = await evaluateSignupCooldown(now);
  if (cooldown.inCooldown) {
    await insertSignupAttempt({ outcome: 'cooldown_refused', ipHash, attemptedAt: now });
    return { ok: false, cooldown: true };
  }

  const activeRows = await db.select().from(station_passcode).where(activePasscodePredicate(now));

  // Decrypt EVERY active row before comparing any of them — see
  // findActivePasscodeMatch for why no early exit.
  const decrypted: Array<{ id: string; decryptedCode: string }> = [];
  for (const row of activeRows) {
    let plaintext: string;
    try {
      plaintext = decryptStationPasscodeValue(row.codeEncrypted);
    } catch (error) {
      throw new StationPasscodeDecryptionError('Failed to decrypt an active station passcode row', { cause: error });
    }
    decrypted.push({ id: row.id, decryptedCode: plaintext });
  }

  const matchedId = findActivePasscodeMatch(decrypted, code);

  if (matchedId) {
    // Single conditional UPDATE — atomic on its own under READ COMMITTED,
    // no advisory lock, no CHECK. Zero rows back means the cap was hit,
    // whether by this exact race or because the row was already exhausted;
    // both classify as passcode_exhausted (issue body).
    // `now.toISOString()`, not the bare Date: postgres-js's raw bind encoder
    // (unlike drizzle's typed `.set()`/`.values()`, which converts through
    // the column's own timestamp mode) requires a string/Buffer parameter
    // and throws a low-level TypeError on a Date object.
    const claimRows = (await db.execute(sql`
      UPDATE ${station_passcode}
      SET use_count = use_count + 1, last_used_at = ${now.toISOString()}
      WHERE id = ${matchedId} AND use_count < max_uses
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    if (claimRows.length > 0) {
      await insertSignupAttempt({ outcome: 'passcode_ok', passcodeId: matchedId, ipHash, attemptedAt: now });
      return { ok: true, cooldown: false };
    }
    await insertSignupAttempt({ outcome: 'passcode_exhausted', passcodeId: matchedId, ipHash, attemptedAt: now });
    return { ok: false, cooldown: false };
  }

  const classification = await classifyInactiveStationPasscode(code, now);
  await insertSignupAttempt({
    outcome: classification.outcome,
    passcodeId: classification.passcodeId,
    ipHash,
    attemptedAt: now,
  });
  return { ok: false, cooldown: false };
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export interface RevealedStationPasscode {
  id: string;
  code: string;
  expiresAt: Date;
  useCount: number;
  maxUses: number;
}

/**
 * Decrypt every active passcode for a stationManager to read aloud, and log
 * one `passcode_revealed` attempt per row revealed. Active-row decrypt
 * failure fails closed here too — same gate-integrity argument as
 * verifyStationPasscode.
 */
export async function revealStationPasscode(
  actorUserId: string,
  now: Date = new Date()
): Promise<RevealedStationPasscode[]> {
  const activeRows = await db.select().from(station_passcode).where(activePasscodePredicate(now));

  const revealed: RevealedStationPasscode[] = [];
  for (const row of activeRows) {
    let plaintext: string;
    try {
      plaintext = decryptStationPasscodeValue(row.codeEncrypted);
    } catch (error) {
      throw new StationPasscodeDecryptionError('Failed to decrypt an active station passcode row', { cause: error });
    }
    revealed.push({
      id: row.id,
      code: plaintext,
      expiresAt: row.expiresAt,
      useCount: row.useCount,
      maxUses: row.maxUses,
    });
    await insertSignupAttempt({ outcome: 'passcode_revealed', passcodeId: row.id, actorUserId, attemptedAt: now });
  }
  return revealed;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export interface RotateStationPasscodeOptions {
  createdBy?: string | null;
  ttlMs?: number;
  maxUses?: number;
  now?: Date;
}

export interface RotatedStationPasscode {
  id: string;
  code: string;
  expiresAt: Date;
  maxUses: number;
}

/**
 * Mint a new station passcode, refusing when two are already active. See
 * STATION_PASSCODE_ROTATE_ADVISORY_LOCK_KEY for why this must serialize on
 * a station-global advisory lock rather than a row lock.
 */
export async function rotateStationPasscode(
  options: RotateStationPasscodeOptions = {}
): Promise<RotatedStationPasscode> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? STATION_PASSCODE_DEFAULT_TTL_MS;
  const maxUses = options.maxUses ?? STATION_PASSCODE_DEFAULT_MAX_USES;
  const { code, codeEncrypted } = generateStationPasscode();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const id = randomUUID();

  await db.transaction(async (tx) => {
    // FIRST statement in the transaction, before the count — see the key's
    // own docstring for why a row lock on the existing row(s) cannot
    // substitute for locking the count-then-insert as a whole.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STATION_PASSCODE_ROTATE_ADVISORY_LOCK_KEY}::bigint)`);

    const active = await tx
      .select({ id: station_passcode.id })
      .from(station_passcode)
      .where(activePasscodePredicate(now));

    if (active.length >= STATION_PASSCODE_MAX_ACTIVE) {
      throw new StationPasscodeCapExceededError();
    }

    await tx.insert(station_passcode).values({
      id,
      codeEncrypted,
      createdBy: options.createdBy ?? null,
      expiresAt,
      maxUses,
    });
  });

  return { id, code, expiresAt, maxUses };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export interface RevokeStationPasscodeOptions {
  revokedReason?: string | null;
  now?: Date;
}

/**
 * Revoke a passcode. Plain conditional UPDATE — revocation only shrinks the
 * active set, so it cannot race with rotation's cap check the way two
 * rotations can race each other, and needs no advisory lock. Returns false
 * if the row does not exist or was already revoked (idempotent no-op).
 */
export async function revokeStationPasscode(
  passcodeId: string,
  options: RevokeStationPasscodeOptions = {}
): Promise<boolean> {
  const now = options.now ?? new Date();
  const updated = await db
    .update(station_passcode)
    .set({ revokedAt: now, revokedReason: options.revokedReason ?? null })
    .where(and(eq(station_passcode.id, passcodeId), isNull(station_passcode.revokedAt)))
    .returning({ id: station_passcode.id });
  return updated.length > 0;
}
