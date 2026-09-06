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
 * KEY ROTATION — the real runbook (BS#2359 review). An earlier revision of
 * this header, of docs/env-vars.md, and of set-ec2-env-var.yml's comment all
 * said rotation was a one-liner: "set a new STATION_PASSCODE_KEY and call
 * rotateStationPasscode, old ciphertext becomes harmless garbage". That
 * procedure BRICKED THE GATE. Pre-rotation rows stay ACTIVE for up to 14
 * days, and an active row that will not decrypt fails the whole request
 * closed — so between setting the key and those rows expiring, every signup
 * attempt and every reveal threw, and the only recovery (revokeStationPasscode
 * has no operator surface until BS#2362) was raw SQL against prod RDS.
 *
 * The gate is DUAL-KEY instead:
 *
 *   1. Set `STATION_PASSCODE_KEY_PREVIOUS` to the key currently in use.
 *   2. Set `STATION_PASSCODE_KEY` to the new key.
 *   3. Call `rotateStationPasscode` (BS#2362's admin surface, or a one-off).
 *   4. Once no row encrypted under the old key is still active — the
 *      rotation in step 3 makes that immediate for the row it mints and
 *      leaves at most one predecessor, which the manager revokes when the
 *      new sticky note is on the wall — retire
 *      `STATION_PASSCODE_KEY_PREVIOUS`. set-ec2-env-var.yml refuses an empty
 *      value, so retiring it means setting it to the SAME value as
 *      `STATION_PASSCODE_KEY` (resolveStationPasscodeKeyRing drops a
 *      previous key identical to the current one, so that is an exact
 *      no-op) or removing the line from the host's .env by hand.
 *
 * DECRYPT tries the current key, then the previous one; ENCRYPT always uses
 * the current key, so the old key drains out of the table on its own and is
 * never written to again. An active row fails closed only when BOTH keys
 * fail. Every ciphertext carries a KEY FINGERPRINT as its first segment
 * (`keyid:iv:tag:ciphertext`), so "decrypt threw" resolves into "this row
 * belongs to a key we no longer hold" versus "this row is corrupt" instead
 * of collapsing into one indistinguishable failure.
 *
 * Operators skip steps. `rotateStationPasscode` therefore ADMINISTRATIVELY
 * REVOKES any active row it cannot decrypt, under its own advisory lock and
 * before the two-row cap count, with `revoked_reason =
 * 'undecryptable_after_key_rotation'` and a loud log line. That is a THIRD
 * decrypt-failure policy on top of the two below, and it is what makes the
 * runbook true even when step 1 was skipped: rotating clears the poisoned
 * rows out of the active set, so the gate comes back up on the new code
 * rather than staying down until someone drives in. It is also why the cap
 * can no longer be wedged by rows nobody can read.
 *
 * The two request-path policies stay as settled: an ACTIVE row's decrypt
 * failure fails closed (gate integrity), an INACTIVE row's is silently
 * skipped (see classifyInactiveStationPasscode) — the same event is a
 * gate-integrity emergency for a row that is supposed to be a live
 * credential right now, and routine cleanup for a row that expired weeks
 * ago. Under dual-key both are edge cases rather than the common path, but
 * neither is allowed to fall through to `passcode_fail`, the REFUSAL token:
 * a skipped row means the submitted code's status is unknowable, which is
 * `passcode_unverifiable`, refusal-exempt by construction.
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
import { and, desc, eq, gt, gte, inArray, isNull, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
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
  // The ninth token (BS#2359 review). "We could not determine whether this
  // code was ever valid" — NOT "it matched nothing", which is what
  // `passcode_fail` means and why `passcode_fail` is the one token that
  // feeds refusal. Two producers, both of them decrypt failures:
  //
  //   1. Classification skipped at least one in-horizon inactive row it
  //      could not decrypt, and the code matched no active row and no
  //      inactive row it COULD decrypt (classifyInactivePasscodeRows).
  //   2. An ACTIVE row would not decrypt, so verification failed closed
  //      before comparing anything (verifyStationPasscode /
  //      revealStationPasscode) — previously that threw with no trace at
  //      all in the attempt log, leaving a broken gate invisible to the
  //      digest and to BS#2362's status endpoint.
  //
  // `passcode_id` is always NULL on this token, in both cases: the
  // plaintext behind an undecryptable row is unknowable, so attributing the
  // attempt to a specific row would be a guess. Producer 2 does know which
  // row failed, and puts that id in its log line instead — a single
  // nullability invariant is worth more to the four downstream consumers
  // than one extra id on a rare path.
  //
  // Joins ALERT_OUTCOMES (a broken gate is exactly what the digest should
  // shout about) and NEVER joins refusal: an undecryptable row is an
  // operator problem, and counting it toward the station-global cooldown
  // would convert a key misconfiguration into the locked-out control room
  // epic BS#2365 forbids. Under dual-key this is a true edge case
  // (corruption, a skipped STATION_PASSCODE_KEY_PREVIOUS, two rotations
  // inside one 30-day horizon), but it has to exist so the skip path can
  // never fall through to `passcode_fail`.
  //
  // 21 characters — fits `outcome varchar(24)` with no migration.
  'passcode_unverifiable',
  'cooldown_refused',
  'cooldown_cleared',
  'passcode_revealed',
] as const;

export type StationSignupOutcome = (typeof STATION_SIGNUP_OUTCOMES)[number];

// Feeds the digest alert (BS#2364). All five "a code was involved and it
// didn't work" outcomes — deliberately excludes cooldown_refused/cleared
// (not failures against a code) and passcode_ok/passcode_revealed (not
// failures at all).
const ALERT_OUTCOMES: ReadonlySet<StationSignupOutcome> = new Set([
  'passcode_fail',
  'passcode_expired',
  'passcode_revoked',
  'passcode_exhausted',
  'passcode_unverifiable',
]);

// Feeds refusal (the cooldown trigger). ONLY genuine no-match failures — see
// the module header and evaluateSignupCooldown for why passcode_expired /
// passcode_revoked / passcode_exhausted / passcode_unverifiable must never
// join this set.
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

/**
 * Width, in hex characters, of the key fingerprint carried as segment 0 of
 * every stored ciphertext. 32 bits of SHA-256 over the RAW key bytes.
 *
 * Not a secret and not a security control: against a random 32-byte key, 32
 * bits of its digest narrows nothing an attacker holding the dump could act
 * on, and the fact that the key changed is already obvious from the
 * ciphertext no longer decrypting. What it buys is DIAGNOSIS — see
 * decryptStationPasscodeValue, which turns "this threw" into "this row
 * belongs to a key we no longer hold" (rotation-shaped, auto-revocable)
 * versus "the fingerprint is one of ours and it STILL failed" (corruption,
 * a genuinely different problem). rotateStationPasscode's auto-revoke and
 * every error message in this module lean on that distinction.
 *
 * STABLE FOREVER once a row exists: changing the algorithm, the input
 * encoding, or this width orphans every stored row at once. It was chosen
 * while `station_passcode` was empty in production, which is the only
 * moment such a choice is free.
 */
const PASSCODE_KEY_ID_LENGTH = 8;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a stored ciphertext could not be opened. The key fingerprint (segment
 * 0 of the stored value) is what makes these distinguishable at all:
 *
 * - `malformed`   — not `keyid:iv:tag:ciphertext`, or segment 0 is not 8 hex
 *                   characters. Corruption, a truncating copy, or a value
 *                   written by something that is not this module.
 * - `unknown_key` — well-formed, but its fingerprint matches neither the
 *                   current key nor `STATION_PASSCODE_KEY_PREVIOUS`. This is
 *                   the ROTATION shape: the row was written under a key the
 *                   process no longer holds. Recoverable by setting
 *                   `STATION_PASSCODE_KEY_PREVIOUS`, and the shape
 *                   rotateStationPasscode administratively revokes.
 * - `corrupt`     — the fingerprint IS one of ours and AES-GCM's auth tag
 *                   still rejected it. The bytes were damaged after being
 *                   written; no key configuration fixes this one.
 */
export type StationPasscodeDecryptFailureReason = 'malformed' | 'unknown_key' | 'corrupt';

/**
 * Thrown when a stored station_passcode ciphertext cannot be opened, and
 * rethrown by callers for which that is fatal. ACTIVE-row decrypt failure
 * fails closed by design: verifyStationPasscode and revealStationPasscode
 * must never fall through to "no match", which would make a
 * misconfigured/rotated key look identical to a run of wrong guesses and
 * silently disable the gate with no loud error anywhere (module header).
 *
 * `reason`/`keyId`/`knownKeyIds` exist so the operator reading the log can
 * tell a skipped rotation step from actual corruption without a database
 * session — see StationPasscodeDecryptFailureReason.
 */
export class StationPasscodeDecryptionError extends Error {
  readonly reason: StationPasscodeDecryptFailureReason;
  /** Fingerprint stored on the row, or null when the value was malformed. */
  readonly keyId: string | null;
  /** Fingerprints of the keys this process actually holds, current first. */
  readonly knownKeyIds: readonly string[];

  constructor(
    message: string,
    options: {
      cause?: unknown;
      reason: StationPasscodeDecryptFailureReason;
      keyId?: string | null;
      knownKeyIds?: readonly string[];
    }
  ) {
    super(message, { cause: options.cause });
    this.name = 'StationPasscodeDecryptionError';
    this.reason = options.reason;
    this.keyId = options.keyId ?? null;
    this.knownKeyIds = options.knownKeyIds ?? [];
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
 * Short, stable fingerprint of a raw key, stored as segment 0 of every
 * ciphertext this module writes. See PASSCODE_KEY_ID_LENGTH for why 32 bits
 * of SHA-256 is enough and why this function can never change.
 */
export function stationPasscodeKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, PASSCODE_KEY_ID_LENGTH);
}

function parseStationPasscodeKeyEnv(name: string, raw: string): Buffer {
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error(`${name} must decode to 32 bytes (64 hex characters); got ${key.length} byte(s)`);
  }
  return key;
}

/**
 * Resolved lazily on every call (never at module import), so importing this
 * module never crashes a process that hasn't set STATION_PASSCODE_KEY yet —
 * e.g. any unit test that pulls in the `@wxyc/authentication` barrel for an
 * unrelated symbol.
 *
 * The CURRENT key. Everything this module ENCRYPTS uses it, always, with no
 * option to write under the previous key — that one-directionality is what
 * makes the old key drain out of the table on its own.
 */
function resolveStationPasscodeKey(): Buffer {
  const raw = process.env.STATION_PASSCODE_KEY;
  if (!raw) throw new Error('STATION_PASSCODE_KEY is not set');
  return parseStationPasscodeKeyEnv('STATION_PASSCODE_KEY', raw);
}

let warnedMalformedPreviousKey = false;

/**
 * The optional PREVIOUS key (`STATION_PASSCODE_KEY_PREVIOUS`), consulted for
 * DECRYPTION only.
 *
 * A malformed value is logged once per process and then IGNORED rather than
 * thrown, deliberately: throwing would take the gate down over a typo in an
 * optional variable, which is the outage BS#2365 forbids, and ignoring it
 * degrades to exactly the pre-dual-key behavior — old rows fail closed,
 * rotateStationPasscode revokes them, the gate comes back on the new code.
 * Loud, once, and recoverable beats silent or fatal.
 */
function resolveStationPasscodePreviousKey(): Buffer | null {
  const raw = process.env.STATION_PASSCODE_KEY_PREVIOUS;
  if (!raw) return null;
  try {
    return parseStationPasscodeKeyEnv('STATION_PASSCODE_KEY_PREVIOUS', raw);
  } catch {
    if (!warnedMalformedPreviousKey) {
      warnedMalformedPreviousKey = true;
      console.error(
        '[station-passcode] STATION_PASSCODE_KEY_PREVIOUS is set but does not decode to 32 bytes (64 hex ' +
          'characters); it is being IGNORED. Rows written under the previous key will not decrypt, an active one ' +
          'will fail verification closed, and the next rotateStationPasscode will administratively revoke it. Fix ' +
          'the value or unset it — see the key-rotation runbook at the top of station-passcode.ts.'
      );
    }
    return null;
  }
}

export interface StationPasscodeKey {
  /** stationPasscodeKeyId(key) — matched against a row's stored segment 0. */
  id: string;
  key: Buffer;
}

/**
 * The decryption key ring: current key first, then
 * `STATION_PASSCODE_KEY_PREVIOUS` when it is set, well-formed, and actually
 * different from the current key (an operator setting both to the same value
 * is a no-op, not a second attempt). Resolved per call, like the keys
 * themselves, so clearing the previous key takes effect on the next request
 * without a restart.
 */
export function resolveStationPasscodeKeyRing(): StationPasscodeKey[] {
  const current = resolveStationPasscodeKey();
  const ring: StationPasscodeKey[] = [{ id: stationPasscodeKeyId(current), key: current }];
  const previous = resolveStationPasscodePreviousKey();
  if (previous && !previous.equals(current)) {
    ring.push({ id: stationPasscodeKeyId(previous), key: previous });
  }
  return ring;
}

/**
 * `keyid:iv:tag:ciphertext` — segment 0 is the current key's fingerprint in
 * hex, the other three are base64. One column, AES-256-GCM.
 *
 * A CLEAN BREAK from the 3-part `iv:tag:ciphertext` format this module
 * shipped with, taken while `station_passcode` was empty in production so it
 * costs nothing exactly once. No legacy reader: accepting a 3-part row would
 * mean guessing which key wrote it, which is precisely the ambiguity the
 * fingerprint exists to remove, and there is no such row anywhere to read.
 */
export function encryptStationPasscodeValue(plaintext: string, key: Buffer = resolveStationPasscodeKey()): string {
  const iv = randomBytes(PASSCODE_IV_LENGTH);
  const cipher = createCipheriv(PASSCODE_CIPHER_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [stationPasscodeKeyId(key), ...[iv, tag, ciphertext].map((buf) => buf.toString('base64'))].join(':');
}

interface ParsedStationPasscodeCiphertext {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const PASSCODE_KEY_ID_PATTERN = new RegExp(`^[0-9a-f]{${PASSCODE_KEY_ID_LENGTH}}$`);

function parseStationPasscodeCiphertext(stored: string): ParsedStationPasscodeCiphertext {
  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new StationPasscodeDecryptionError(
      `Malformed station passcode ciphertext: expected keyid:iv:tag:ciphertext, got ${parts.length} segment(s)`,
      { reason: 'malformed' }
    );
  }
  const [keyId, ivB64, tagB64, ciphertextB64] = parts;
  if (!PASSCODE_KEY_ID_PATTERN.test(keyId)) {
    throw new StationPasscodeDecryptionError(
      `Malformed station passcode ciphertext: segment 0 is not a ${PASSCODE_KEY_ID_LENGTH}-character hex key id`,
      { reason: 'malformed' }
    );
  }
  return {
    keyId,
    iv: Buffer.from(ivB64, 'base64'),
    tag: Buffer.from(tagB64, 'base64'),
    ciphertext: Buffer.from(ciphertextB64, 'base64'),
  };
}

function openStationPasscodeCiphertext(parsed: ParsedStationPasscodeCiphertext, key: Buffer): string {
  const decipher = createDecipheriv(PASSCODE_CIPHER_ALGORITHM, key, parsed.iv);
  decipher.setAuthTag(parsed.tag);
  return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Inverse of encryptStationPasscodeValue, over the whole key ring: the
 * CURRENT key first, then `STATION_PASSCODE_KEY_PREVIOUS`. Throws only when
 * BOTH fail — which is the fail-closed behavior active-row callers below
 * depend on, now narrowed to the cases that genuinely warrant it.
 *
 * The stored fingerprint picks the key rather than blind trial, so the
 * common path is one AES-GCM open and the failure is CLASSIFIED (see
 * StationPasscodeDecryptFailureReason). Keys whose fingerprint does not
 * match are still tried afterwards: it costs microseconds on a path that is
 * already failing, and it means this function can never fail where naive
 * "try every key" would have succeeded. The reported `reason` comes from the
 * fingerprint comparison regardless, so that fallback cannot muddy the
 * rotation-versus-corruption diagnosis.
 *
 * `keys` accepts a bare Buffer for the pure unit tests (and any caller that
 * genuinely means one specific key); production callers take the default.
 */
export function decryptStationPasscodeValue(
  stored: string,
  keys: Buffer | ReadonlyArray<Buffer> = resolveStationPasscodeKeyRing().map((entry) => entry.key)
): string {
  const ring = Buffer.isBuffer(keys) ? [keys] : [...keys];
  const parsed = parseStationPasscodeCiphertext(stored);
  const knownKeyIds = ring.map(stationPasscodeKeyId);

  const fingerprintMatches = ring.filter((_, index) => knownKeyIds[index] === parsed.keyId);
  const rest = ring.filter((_, index) => knownKeyIds[index] !== parsed.keyId);

  let lastError: unknown;
  for (const key of [...fingerprintMatches, ...rest]) {
    try {
      return openStationPasscodeCiphertext(parsed, key);
    } catch (error) {
      lastError = error;
    }
  }

  const recognized = fingerprintMatches.length > 0;
  throw new StationPasscodeDecryptionError(
    recognized
      ? `Station passcode ciphertext failed authentication under its own key ${parsed.keyId} — the stored bytes are corrupt, not merely encrypted under an older key`
      : `Station passcode ciphertext was written under key ${parsed.keyId}, which this process does not hold (holding: ${knownKeyIds.join(', ') || 'none'}). Set STATION_PASSCODE_KEY_PREVIOUS to that key, or rotate to retire the row — see the runbook at the top of station-passcode.ts`,
    { cause: lastError, reason: recognized ? 'corrupt' : 'unknown_key', keyId: parsed.keyId, knownKeyIds }
  );
}

/**
 * Normalize whatever a decrypt threw into a StationPasscodeDecryptionError
 * naming the row, for the paths where an ACTIVE row failing to decrypt is
 * fatal. Preserves the classified `reason` when there is one.
 */
function activeRowDecryptionError(error: unknown, passcodeId: string): StationPasscodeDecryptionError {
  const base =
    error instanceof StationPasscodeDecryptionError
      ? error
      : new StationPasscodeDecryptionError(String(error), { cause: error, reason: 'corrupt' });
  return new StationPasscodeDecryptionError(
    `Failed to decrypt ACTIVE station passcode row ${passcodeId} (${base.reason}): ${base.message}`,
    { cause: error, reason: base.reason, keyId: base.keyId, knownKeyIds: base.knownKeyIds }
  );
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

/**
 * Record a `passcode_unverifiable` row for an ACTIVE-row decrypt failure and
 * swallow any error doing so (BS#2359 review).
 *
 * Best-effort on purpose. The caller is about to throw the decrypt failure,
 * and that error — a broken gate — is strictly more important than this
 * insert; letting a failed INSERT replace it would hide the cause behind a
 * database error. Before this existed, an active-row decrypt failure threw
 * before ANY insertSignupAttempt, so a gate that was down for every request
 * left no trace whatsoever in the attempt log that BS#2362's status endpoint
 * and BS#2364's digest both read.
 *
 * `passcodeId` is deliberately NOT passed even though the caller knows which
 * row failed — see the `passcode_unverifiable` note in
 * STATION_SIGNUP_OUTCOMES for why the token keeps a single NULL invariant
 * and puts the row id in the log line instead.
 */
async function logUnverifiableAttempt(params: {
  actorUserId?: string | null;
  ipHash?: string | null;
  attemptedAt: Date;
}): Promise<void> {
  try {
    await insertSignupAttempt({ outcome: 'passcode_unverifiable', passcodeId: null, ...params });
  } catch (error) {
    console.error('[station-passcode] failed to record a passcode_unverifiable attempt row', error);
  }
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
 * The trigger/hold half of the cooldown, over `passcode_fail` rows ONLY —
 * the caller must have filtered already (evaluateSignupCooldown does it in
 * SQL, computeSignupCooldownState in JS). Order-independent: every row is
 * evaluated against its own trailing window, so a DESC fetch works as well
 * as an ASC one.
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
export function isSignupCooldownTriggered(noMatchFailures: ReadonlyArray<{ attemptedAt: Date }>, now: Date): boolean {
  for (const row of noMatchFailures) {
    if (now.getTime() - row.attemptedAt.getTime() >= SIGNUP_COOLDOWN_HOLD_MS) continue;
    const trailingFloor = new Date(row.attemptedAt.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);
    const trailingCount = noMatchFailures.filter(
      (r) => r.attemptedAt > trailingFloor && r.attemptedAt <= row.attemptedAt
    ).length;
    if (trailingCount > SIGNUP_COOLDOWN_THRESHOLD) return true;
  }
  return false;
}

/**
 * Pure arithmetic over an already-fetched, already-failure-filtered row set
 * (outcome restricted to ALERT_OUTCOMES by the caller). Exported so the unit
 * suite can exercise the trigger/hold/clear-floor math and the count split
 * in one place without a database — see the module docs on why
 * `jest.unit.config.ts`'s DB mock can't prove anything about this
 * arithmetic itself.
 *
 * NOTE: `evaluateSignupCooldown` no longer routes production through this
 * function — the two counts moved into SQL (see there for why) and only the
 * trigger math still reads rows. This stays the executable specification of
 * what those SQL counts must produce, and the integration suite asserts the
 * two agree.
 */
export function computeSignupCooldownState(
  rows: ReadonlyArray<{ outcome: string; attemptedAt: Date }>,
  now: Date
): SignupCooldownEvaluation {
  const windowStart = new Date(now.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);
  const noMatchFailures = rows.filter((r) => r.outcome === REFUSAL_OUTCOME);

  return {
    inCooldown: isSignupCooldownTriggered(noMatchFailures, now),
    noMatchFailureCount: noMatchFailures.filter((r) => r.attemptedAt >= windowStart).length,
    allFailureCount: rows.filter((r) => r.attemptedAt >= windowStart).length,
  };
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
 * The floor for the two RETURNED COUNTS, which are scoped to the 10-minute
 * window rather than the full window+hold lookback the trigger check needs.
 * The manager's clear is a floor on this too — same rule, tighter start.
 * Pure, exported alongside resolveCooldownLookbackStart for the unit suite.
 */
export function resolveCooldownCountStart(now: Date, clearedAt: Date | null): Date {
  const windowStart = new Date(now.getTime() - SIGNUP_COOLDOWN_WINDOW_MS);
  return clearedAt && clearedAt.getTime() > windowStart.getTime() ? clearedAt : windowStart;
}

/**
 * Newest-first cap on the rows fetched for the trigger math. A belt, not the
 * correctness argument: the fetch is already restricted to `passcode_fail`,
 * which is bounded by construction because it is the only outcome that feeds
 * refusal — past SIGNUP_COOLDOWN_THRESHOLD of them in the window the cooldown
 * engages and further attempts log `cooldown_refused` instead.
 *
 * It cannot cause a false negative. The rows are the newest in the lookback,
 * so if any qualifying row's trailing window holds more than
 * SIGNUP_COOLDOWN_THRESHOLD failures, at least that many are among the
 * retained ones (500 >> 21). Beyond 500 no-match failures inside 25 minutes
 * the answer is "in cooldown" under any reading.
 */
export const SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT = 500;

/**
 * Evaluate the station-global signup cooldown. Read-only — safe to call on
 * every poll of a status endpoint (#2362) without side effects.
 *
 * THREE outcome-first queries, all served by the composite
 * (outcome, attempted_at) index — see the table's header comment in
 * schema.ts:
 *
 *   1. the most recent `cooldown_cleared` row (the window floor);
 *   2. an AGGREGATE over the failure outcomes in the count window —
 *      `count(*) FILTER (WHERE outcome = 'passcode_fail')` plus a plain
 *      `count(*)` — returning exactly one row;
 *   3. the `passcode_fail` rows in the trigger lookback, newest first and
 *      capped, for isSignupCooldownTriggered.
 *
 * Query 2 used to be query 3's job: one SELECT materialized every failure
 * row in the 25-minute lookback into Node and both counts were computed
 * there. That is O(N) per request in the one place N is attacker-influenced.
 * `passcode_exhausted` and `passcode_unverifiable` are refusal-exempt BY
 * DESIGN — that exemption is the whole availability argument — so they are
 * unbounded: anyone looping a dead code grows the row set without ever
 * engaging the cooldown that would stop them, and every subsequent request
 * pays to materialize the pile. The near cliff is Node materialization and
 * the row transfer, not the 5s statement_timeout. Counting in Postgres makes
 * the returned counts O(1) work for this process, and restricting query 3 to
 * the one bounded outcome keeps the only remaining row fetch small.
 *
 * The RETURN SHAPE is unchanged and must stay unchanged — #2361, #2362,
 * #2363 and #2364 all consume `{ inCooldown, noMatchFailureCount,
 * allFailureCount }`.
 */
export async function evaluateSignupCooldown(now: Date = new Date()): Promise<SignupCooldownEvaluation> {
  const [clearedRow] = await db
    .select({ attemptedAt: station_signup_attempt.attemptedAt })
    .from(station_signup_attempt)
    .where(eq(station_signup_attempt.outcome, 'cooldown_cleared'))
    .orderBy(desc(station_signup_attempt.attemptedAt))
    .limit(1);
  const clearedAt = clearedRow?.attemptedAt ?? null;

  const [counts] = await db
    .select({
      noMatchFailureCount: sql<number>`count(*) FILTER (WHERE ${eq(station_signup_attempt.outcome, REFUSAL_OUTCOME)})::int`,
      allFailureCount: sql<number>`count(*)::int`,
    })
    .from(station_signup_attempt)
    .where(
      and(
        inArray(station_signup_attempt.outcome, [...ALERT_OUTCOMES]),
        gte(station_signup_attempt.attemptedAt, resolveCooldownCountStart(now, clearedAt))
      )
    );

  const noMatchFailures = await db
    .select({ attemptedAt: station_signup_attempt.attemptedAt })
    .from(station_signup_attempt)
    .where(
      and(
        eq(station_signup_attempt.outcome, REFUSAL_OUTCOME),
        gte(station_signup_attempt.attemptedAt, resolveCooldownLookbackStart(now, clearedAt))
      )
    )
    .orderBy(desc(station_signup_attempt.attemptedAt))
    .limit(SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT);

  return {
    inCooldown: isSignupCooldownTriggered(noMatchFailures, now),
    noMatchFailureCount: counts?.noMatchFailureCount ?? 0,
    allFailureCount: counts?.allFailureCount ?? 0,
  };
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
  outcome: Extract<
    StationSignupOutcome,
    'passcode_fail' | 'passcode_expired' | 'passcode_revoked' | 'passcode_unverifiable'
  >;
  passcodeId: string | null;
}

/**
 * The pure half of classification — exported so the unit suite can prove the
 * fall-through, which is the part that was wrong.
 *
 * Decrypting an inactive row is silently SKIPPED on failure, never fail
 * closed (the settled policy: pre-rotation rows are undecryptable by design
 * and failing closed on them would break the endpoint for the whole 30-day
 * horizon). What that skip FALLS THROUGH TO was never decided, and the first
 * implementation `continue`d straight into `{ outcome: 'passcode_fail' }` —
 * the REFUSAL token. Undecryptable rows therefore fed the station-global
 * cooldown, meaning a key misconfiguration could push the station into
 * cooldown on legitimate traffic: the exact "legitimate user's mistake
 * becomes an outage" shape BS#2365 forbids.
 *
 * So the skip is remembered. Matching no active row, no DECRYPTABLE
 * in-horizon inactive row, and having skipped at least one is
 * `passcode_unverifiable`: honest ("we cannot tell"), refusal-exempt, and
 * still alerting. Only a clean sweep with nothing skipped is `passcode_fail`.
 *
 * Not constant-time: unlike the active-row match, an early return here
 * costs nothing an attacker can use (the client response stays generic
 * regardless — see verifyStationPasscode), and there is no live credential
 * whose comparison is worth spending on a code already known to be no
 * longer valid.
 */
export function classifyInactivePasscodeRows(
  rows: ReadonlyArray<{ id: string; revokedAt: Date | null; codeEncrypted: string }>,
  code: string,
  decrypt: (stored: string) => string = (stored) => decryptStationPasscodeValue(stored)
): InactiveClassification {
  let skippedUndecryptable = false;

  for (const row of rows) {
    let plaintext: string;
    try {
      plaintext = decrypt(row.codeEncrypted);
    } catch {
      skippedUndecryptable = true;
      continue;
    }
    if (constantTimeStringsEqual(plaintext, code)) {
      return { outcome: row.revokedAt ? 'passcode_revoked' : 'passcode_expired', passcodeId: row.id };
    }
  }

  return { outcome: skippedUndecryptable ? 'passcode_unverifiable' : 'passcode_fail', passcodeId: null };
}

/**
 * Verification already failed against every ACTIVE row. Before logging a
 * bare `passcode_fail`, check whether the code matches a row that recently
 * stopped being active — a stale sticky note, not a guess — so the digest
 * alert (#2364) can tell the two apart. The bounded horizon is
 * STATION_PASSCODE_CLASSIFICATION_HORIZON_MS; see
 * classifyInactivePasscodeRows for the decrypt-failure policy.
 */
async function classifyInactiveStationPasscode(code: string, now: Date): Promise<InactiveClassification> {
  const since = new Date(now.getTime() - STATION_PASSCODE_CLASSIFICATION_HORIZON_MS);
  const rows = await db.select().from(station_passcode).where(recentlyInactivePasscodePredicate(now, since));
  return classifyInactivePasscodeRows(rows, code);
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
  // findActivePasscodeMatch for why no early exit. Both keys are tried
  // (decryptStationPasscodeValue); this only fires when the ring holds
  // neither the key that wrote the row nor an intact copy of its bytes.
  const decrypted: Array<{ id: string; decryptedCode: string }> = [];
  for (const row of activeRows) {
    let plaintext: string;
    try {
      plaintext = decryptStationPasscodeValue(row.codeEncrypted);
    } catch (error) {
      const failure = activeRowDecryptionError(error, row.id);
      console.error(
        `[station-passcode] GATE DOWN: active passcode row ${row.id} will not decrypt (${failure.reason}). ` +
          'Every signup attempt fails closed until this row leaves the active set. Set ' +
          'STATION_PASSCODE_KEY_PREVIOUS to the key that wrote it, or call rotateStationPasscode, which ' +
          'administratively revokes undecryptable active rows — see the runbook at the top of ' +
          'station-passcode.ts.',
        failure
      );
      await logUnverifiableAttempt({ ipHash, attemptedAt: now });
      throw failure;
    }
    decrypted.push({ id: row.id, decryptedCode: plaintext });
  }

  const matchedId = findActivePasscodeMatch(decrypted, code);

  if (matchedId) {
    // Single conditional UPDATE — atomic on its own under READ COMMITTED,
    // no advisory lock, no CHECK. Zero rows back means the claim lost;
    // that classifies as passcode_exhausted (issue body), which is
    // refusal-exempt because the submitted code was CORRECT.
    //
    // The predicate re-checks the full active predicate, not just the use
    // cap (BS#2359 review). Revocation is this design's one authoritative
    // manual lever — the cooldown deliberately never revokes anything — so
    // a code revoked between the SELECT above and this UPDATE must not
    // still be claimable; likewise one that expired in the same gap. Both
    // widen the same race the `use_count < max_uses` term already closes.
    // A loser here stays passcode_exhausted rather than costing another
    // SELECT to re-read why: it IS the claim-race token by definition, it
    // never feeds refusal either way, and the row's own revoked_at /
    // expires_at carry the reason for anyone auditing later.
    //
    // `now.toISOString()`, not the bare Date: postgres-js's raw bind encoder
    // (unlike drizzle's typed `.set()`/`.values()`, which converts through
    // the column's own timestamp mode) requires a string/Buffer parameter
    // and throws a low-level TypeError on a Date object.
    const claimRows = (await db.execute(sql`
      UPDATE ${station_passcode}
      SET use_count = use_count + 1, last_used_at = ${now.toISOString()}
      WHERE id = ${matchedId}
        AND use_count < max_uses
        AND revoked_at IS NULL
        AND expires_at > ${now.toISOString()}
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
      const failure = activeRowDecryptionError(error, row.id);
      console.error(
        `[station-passcode] GATE DOWN: active passcode row ${row.id} will not decrypt (${failure.reason}) on a ` +
          `reveal by ${actorUserId}. The signup gate is failing closed for the same reason. Set ` +
          'STATION_PASSCODE_KEY_PREVIOUS to the key that wrote it, or call rotateStationPasscode, which ' +
          'administratively revokes undecryptable active rows — see the runbook at the top of ' +
          'station-passcode.ts.',
        failure
      );
      // Logged like the verify path (BS#2359 review) so a gate broken by a
      // key misconfiguration is visible in the attempt log rather than only
      // in whatever the manager's client did with the exception. actorUserId
      // is what distinguishes this producer from the request-path one.
      await logUnverifiableAttempt({ actorUserId, attemptedAt: now });
      throw failure;
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
  /**
   * Ids of active rows this rotation administratively revoked because they
   * would not decrypt. Normally empty. Non-empty means a key rotation
   * happened without `STATION_PASSCODE_KEY_PREVIOUS` (or the row is corrupt)
   * and the manager should assume any sticky note carrying those codes is
   * now dead — BS#2362's admin surface should say so out loud.
   */
  autoRevokedPasscodeIds: string[];
}

/**
 * `revoked_reason` written by rotateStationPasscode's auto-revoke. A
 * constant so the admin surface (#2362) and any forensic query can match it
 * exactly rather than by prose.
 */
export const STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON = 'undecryptable_after_key_rotation';

/**
 * Mint a new station passcode, refusing when two are already active. See
 * STATION_PASSCODE_ROTATE_ADVISORY_LOCK_KEY for why this must serialize on
 * a station-global advisory lock rather than a row lock.
 *
 * AUTO-REVOKE (BS#2359 review). Inside the same lock, before the cap count,
 * every active row is decrypted and any that will not open under EITHER key
 * is revoked with `revoked_reason =
 * 'undecryptable_after_key_rotation'` and a loud log line. That single step
 * is what makes the documented one-step key-rotation runbook true, and it
 * fixes both ways the old procedure bricked the gate:
 *
 *   - CAP-EXCEEDED: two poisoned rows are still "active" by the SQL
 *     predicate, so rotation itself threw StationPasscodeCapExceededError
 *     and there was no way to mint a working code. Revoked rows no longer
 *     count.
 *   - POISONED-VERIFY: an undecryptable ACTIVE row fails every
 *     verifyStationPasscode closed, so even a freshly minted code could not
 *     get through. Revoking takes the stale row out of the active set, and
 *     the new code works immediately.
 *
 * This is a THIRD decrypt-failure policy alongside the two settled in the
 * issue (active → fail closed, inactive → skip): during rotation, an active
 * row that will not decrypt is ADMINISTRATIVELY REVOKED. It is safe
 * precisely because it is not on the request path — rotation is a deliberate
 * operator action whose whole purpose is to change which codes are live, and
 * a code nobody can decrypt is a code nobody can verify, so revoking it
 * destroys no capability that still existed.
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
  const autoRevokedPasscodeIds: string[] = [];

  await db.transaction(async (tx) => {
    // Reset per attempt: the callback can run more than once if the
    // transaction is retried, and a stale id list would over-report.
    autoRevokedPasscodeIds.length = 0;

    // FIRST statement in the transaction, before the count — see the key's
    // own docstring for why a row lock on the existing row(s) cannot
    // substitute for locking the count-then-insert as a whole. The
    // auto-revoke below is inside the same lock for the same reason: it
    // changes the very set the cap counts.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${STATION_PASSCODE_ROTATE_ADVISORY_LOCK_KEY}::bigint)`);

    const active = await tx
      .select({ id: station_passcode.id, codeEncrypted: station_passcode.codeEncrypted })
      .from(station_passcode)
      .where(activePasscodePredicate(now));

    const usable: string[] = [];
    for (const row of active) {
      let failure: StationPasscodeDecryptionError | null = null;
      try {
        decryptStationPasscodeValue(row.codeEncrypted);
      } catch (error) {
        failure = activeRowDecryptionError(error, row.id);
      }

      if (!failure) {
        usable.push(row.id);
        continue;
      }

      console.error(
        `[station-passcode] AUTO-REVOKING active passcode row ${row.id}: it will not decrypt under any key this ` +
          `process holds (${failure.reason}). Any sticky note carrying that code is now dead. This is what a key ` +
          'rotation performed without STATION_PASSCODE_KEY_PREVIOUS looks like — see the runbook at the top of ' +
          'station-passcode.ts.',
        failure
      );

      await tx
        .update(station_passcode)
        .set({ revokedAt: now, revokedReason: STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON })
        .where(and(eq(station_passcode.id, row.id), isNull(station_passcode.revokedAt)));
      autoRevokedPasscodeIds.push(row.id);
    }

    // Counts only rows that survived the sweep — a poisoned row can no
    // longer wedge the cap and leave the station with no mintable code.
    if (usable.length >= STATION_PASSCODE_MAX_ACTIVE) {
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

  return { id, code, expiresAt, maxUses, autoRevokedPasscodeIds };
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
