/**
 * `ip_hash` derivation (BS#2359 per the `station_signup_attempt.ip_hash`
 * column comment in shared/database/src/schema.ts — read that comment for
 * the full specification; this is the implementation, not a second copy of
 * the spec).
 *
 * Extracted out of `station-passcode.ts` (BS#2537, parent epic #2534
 * decision 8) into its own leaf: this function is pure, but
 * `station-passcode.ts` imports `db` + two tables from `@wxyc/database` at
 * module scope, so re-exporting the hash helper from there would drag a
 * 1500-line module plus the DB double into every unit test that imports
 * `@wxyc/authentication` — including the account-audit coverage tests this
 * module exists to serve, which have no other reason to touch the DB mock.
 * `station-passcode.ts` now imports `deriveStationSignupIpHash` from here;
 * behavior is unchanged (pure move).
 */
import { createHmac } from 'crypto';
import { isIP } from 'net';

let warnedMissingIpHmacKey = false;

// Simplify pass (code review BS#2537 PR #2545 follow-up): this function now
// runs per audited HTTP request (account-audit-middleware.ts), not just per
// station-signup attempt, so re-deriving the Buffer from the raw env string
// on every call is worth memoizing. Keyed on the RAW STRING, not an
// unconditional first-call cache: `tests/unit/authentication/signup-ip-hash.test.ts`
// mutates `process.env.STATION_SIGNUP_IP_HMAC_KEY` between cases and must
// see each new value take effect immediately, not a stale cached key from
// an earlier test.
let cachedRawKey: string | undefined;
let cachedKey: Buffer | null = null;

function resolveSignupIpHmacKey(): Buffer | null {
  const raw = process.env.STATION_SIGNUP_IP_HMAC_KEY;
  if (raw === cachedRawKey) return cachedKey;
  cachedRawKey = raw;
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  const key = Buffer.from(raw, 'hex');
  cachedKey = key.length === 32 ? key : null;
  return cachedKey;
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
 * KEYED hash of the canonical client IP for an audit-only `ip_hash` column.
 * See the column comment in shared/database/src/schema.ts for the full
 * specification (which header, canonicalization, key encoding). Shared by
 * `station_signup_attempt` and `account_audit_event` — both key off the same
 * `STATION_SIGNUP_IP_HMAC_KEY` (parent epic #2534 decision 8: cross-log
 * correlation only exists under a shared key, and both keys live in the same
 * EC2 `.env` so the compromise boundary is identical).
 *
 * The DERIVATION fails closed (never an unkeyed digest — see the schema
 * comment on why that would be worthless). The REQUEST does not: a missing
 * key, absent header, or invalid IP returns null and the request proceeds —
 * refusing a walk-in DJ (or degrading an audit row to no IP) over an
 * audit-only column is not an acceptable outage. A misconfigured key is
 * logged once per process (not once per request) so a production
 * misconfiguration is discoverable without flooding the logs.
 */
export function deriveStationSignupIpHash(rawClientIp: string | undefined): string | null {
  const key = resolveSignupIpHmacKey();
  if (!key) {
    if (!warnedMissingIpHmacKey) {
      warnedMissingIpHmacKey = true;
      console.error(
        '[signup-ip-hash] STATION_SIGNUP_IP_HMAC_KEY is missing or not 64 hex characters; ip_hash will be ' +
          'recorded as NULL on every affected write until it is set. The gate itself is unaffected — see ' +
          'the ip_hash column comment in shared/database/src/schema.ts.'
      );
    }
    return null;
  }
  const canonical = canonicalizeStationSignupClientIp(rawClientIp);
  if (!canonical) return null;
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex').slice(0, 16);
}
