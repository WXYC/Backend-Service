/**
 * /internal/banned-fingerprints CRUD (BS#1261).
 *
 * Three endpoints for request-o-matic to manage request-line bans on behalf
 * of operators. ROM owns the operator UX (Slack slash commands, etc.); this
 * service owns the storage. Each endpoint gates on `X-Internal-Key` matched
 * against `ROM_INTERNAL_KEY` — a NEW env var, not reused from
 * `ETL_NOTIFY_KEY` (different caller, different blast radius — see the
 * spec).
 *
 * The check-request-ban side that consumes these rows lives at
 * `apps/auth/check-request-ban-handler.ts`.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq, desc, sql } from 'drizzle-orm';
import { db, banned_fingerprints } from '@wxyc/database';

const ROM_INTERNAL_KEY = process.env.ROM_INTERNAL_KEY ?? '';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Operator-displayable upper bound. ban_reason renders into the eventual
// Slack/operator UI; a multi-megabyte string would break consumers and is
// a soft DoS surface if ROM_INTERNAL_KEY leaks. PG `text` itself has no
// practical limit (~1GB), so we cap at the application layer.
const MAX_REASON_LENGTH = 1000;
// auth_user.id is varchar(255); reject longer inputs at the route layer
// rather than waiting for the FK insert to raise a string-length error and
// surface as a 500.
const MAX_USER_ID_LENGTH = 255;

const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Per-IP rate limit on the CRUD surface. Calls are key-gated so a legitimate
// ROM at expected operator volume sits comfortably below this limit; the cap
// bounds the blast radius if ROM_INTERNAL_KEY leaks or a buggy ROM retry
// loop fires. Disabled in dev/test to keep integration suites deterministic
// (mirrors the conditional in apps/auth/app.ts).
const internalBansRateLimit = isDevOrTest
  ? (_req: unknown, _res: unknown, next: () => void) => next()
  : rateLimit({
      windowMs: 60_000,
      limit: 120, // 2/s sustained, well above expected operator volume
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    });

export const internalBansRoute = Router();
internalBansRoute.use(internalBansRateLimit);

function authenticateInternal(key: string | undefined): boolean {
  return !!ROM_INTERNAL_KEY && key === ROM_INTERNAL_KEY;
}

// ---- POST /internal/banned-fingerprints ----
// Idempotent: existing ban with same fingerprint → 200 with current state.
internalBansRoute.post('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = (req.body ?? {}) as {
    fingerprint?: unknown;
    reason?: unknown;
    expiresInSeconds?: unknown;
    bannedByUserId?: unknown;
  };

  if (typeof body.fingerprint !== 'string' || !UUID_REGEX.test(body.fingerprint)) {
    return res.status(400).json({ error: 'fingerprint must be a valid UUID' });
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    return res.status(400).json({ error: 'reason is required' });
  }
  const trimmedReason = body.reason.trim();
  if (trimmedReason.length > MAX_REASON_LENGTH) {
    return res.status(400).json({ error: `reason must be at most ${MAX_REASON_LENGTH} characters` });
  }

  let banExpiresAt: Date | null = null;
  if (body.expiresInSeconds !== undefined) {
    if (
      typeof body.expiresInSeconds !== 'number' ||
      !Number.isInteger(body.expiresInSeconds) ||
      body.expiresInSeconds <= 0
    ) {
      return res.status(400).json({ error: 'expiresInSeconds must be a positive integer' });
    }
    banExpiresAt = new Date(Date.now() + body.expiresInSeconds * 1000);
  }

  // bannedByUserId is optional. Reject wrong-type values and over-long
  // strings so operator typos surface as 400 rather than 500 from a downstream
  // FK or string-length error. Empty string is rejected because it could
  // never satisfy the FK (no auth_user.id is '').
  let bannedByUserId: string | null = null;
  if (body.bannedByUserId !== undefined && body.bannedByUserId !== null) {
    if (typeof body.bannedByUserId !== 'string') {
      return res.status(400).json({ error: 'bannedByUserId must be a string when provided' });
    }
    if (body.bannedByUserId.length === 0 || body.bannedByUserId.length > MAX_USER_ID_LENGTH) {
      return res.status(400).json({ error: `bannedByUserId must be between 1 and ${MAX_USER_ID_LENGTH} characters` });
    }
    bannedByUserId = body.bannedByUserId;
  }

  try {
    // Idempotent upsert. On conflict:
    //   - `ban_reason` / `ban_expires_at` move to the new values (the caller
    //     is asserting fresh facts about why and for how long).
    //   - `banned_by_user_id` uses COALESCE so a re-ban that omits
    //     attribution preserves the original actor — silently NULLing
    //     someone else's audit trail is worse than skipping the update.
    //   - `banned_at` advances to now() so the GET listing's ORDER BY
    //     banned_at DESC surfaces re-bans as recent activity.
    const rows = await db
      .insert(banned_fingerprints)
      .values({
        fingerprint: body.fingerprint,
        ban_reason: trimmedReason,
        ban_expires_at: banExpiresAt,
        banned_by_user_id: bannedByUserId,
      })
      .onConflictDoUpdate({
        target: banned_fingerprints.fingerprint,
        set: {
          ban_reason: sql`excluded.ban_reason`,
          ban_expires_at: sql`excluded.ban_expires_at`,
          banned_by_user_id: sql`COALESCE(excluded.banned_by_user_id, ${banned_fingerprints.banned_by_user_id})`,
          banned_at: sql`now()`,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) {
      return res.status(500).json({ error: 'Insert returned no row' });
    }
    return res.status(200).json({
      fingerprint: row.fingerprint,
      banned_at: row.banned_at,
      ban_reason: row.ban_reason,
      ban_expires_at: row.ban_expires_at,
      banned_by_user_id: row.banned_by_user_id,
    });
  } catch (error) {
    // PG foreign_key_violation (SQLSTATE 23503) on bannedByUserId — operator
    // passed a string that's well-formed but doesn't match any auth_user.id.
    // Surface as 400 so the caller can correct the input instead of being
    // told the server is broken. Existence-check round-trip avoided.
    const pgError = error as { code?: string };
    if (pgError?.code === '23503') {
      return res.status(400).json({ error: 'bannedByUserId does not reference an existing user' });
    }
    console.error('[INTERNAL BANS] POST error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- DELETE /internal/banned-fingerprints/:fingerprint ----
// Idempotent: 204 whether or not a row existed.
internalBansRoute.delete('/:fingerprint', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { fingerprint } = req.params;
  if (!UUID_REGEX.test(fingerprint)) {
    return res.status(400).json({ error: 'fingerprint must be a valid UUID' });
  }

  try {
    await db.delete(banned_fingerprints).where(eq(banned_fingerprints.fingerprint, fingerprint));
    return res.status(204).end();
  } catch (error) {
    console.error('[INTERNAL BANS] DELETE error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- GET /internal/banned-fingerprints?limit=&cursor= ----
// Keyset-paginated list ordered by (banned_at DESC, fingerprint DESC).
// Cursor is "<iso_timestamp>|<fingerprint_uuid>" — a composite tiebreaker
// so two rows sharing the same `banned_at` don't get skipped at the page
// boundary.
//
// Pagination consistency caveat: `banned_at` is a mutable sort key
// (re-bans bump it to now() via the POST upsert). A row that gets re-banned
// AFTER its bucket has been paged past is invisible to the rest of the
// current pagination run — its `banned_at` is now above the cursor and the
// cursor only moves DESC. This is intrinsic to keyset pagination on
// mutable sort keys; clients that need a globally-consistent snapshot
// should restart from the first page or accept the eventual-consistency
// trade-off. At expected operator-ban volume (low writes, slow re-bans),
// the practical impact is negligible.
internalBansRoute.get('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawLimitParam = req.query.limit;
  if (rawLimitParam !== undefined) {
    if (typeof rawLimitParam !== 'string') {
      return res.status(400).json({ error: 'limit must be a single integer query param' });
    }
    const parsed = Number(rawLimitParam);
    if (!Number.isInteger(parsed) || parsed < MIN_LIMIT || parsed > MAX_LIMIT) {
      return res.status(400).json({ error: `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}` });
    }
  }
  const limit = rawLimitParam === undefined ? DEFAULT_LIMIT : Number(rawLimitParam);

  let cursor: { bannedAt: Date; fingerprint: string } | null = null;
  if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
    const separatorIdx = req.query.cursor.lastIndexOf('|');
    if (separatorIdx === -1) {
      return res.status(400).json({ error: 'cursor must be "<iso_timestamp>|<fingerprint_uuid>"' });
    }
    const tsPart = req.query.cursor.slice(0, separatorIdx);
    const fpPart = req.query.cursor.slice(separatorIdx + 1);
    const parsed = new Date(tsPart);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'cursor timestamp segment must be a valid ISO string' });
    }
    if (!UUID_REGEX.test(fpPart)) {
      return res.status(400).json({ error: 'cursor fingerprint segment must be a UUID' });
    }
    cursor = { bannedAt: parsed, fingerprint: fpPart };
  }

  try {
    // Ask for limit+1 so we can detect whether another page exists.
    //
    // The cursor encodes `banned_at` via JS Date.toISOString() (millisecond
    // precision), but PG stores timestamptz at microsecond precision. To
    // avoid silently skipping rows whose microsecond component sits below
    // the truncated cursor (e.g. .789008 < .789000 after JS truncation),
    // truncate the column to milliseconds in the predicate so both sides
    // operate at the same granularity. The fingerprint tiebreaker then
    // determines order within the millisecond bucket. Sort order also
    // truncates so it agrees with the predicate.
    //
    // Pre-stringify the Date cursor side — drizzle's postgres-js driver
    // rebinds the 1184/1114 outbound serializers to a passthrough, so a raw
    // `Date` inside `sql\`\`` flows into postgres-js's Bind layer
    // unconverted and throws ERR_INVALID_ARG_TYPE. Same trap documented in
    // jobs/library-identity-consumer/writer.ts and the BS#802 fix.
    const query = db.select().from(banned_fingerprints);
    const withCursor = cursor
      ? query.where(
          sql`(date_trunc('milliseconds', ${banned_fingerprints.banned_at}), ${banned_fingerprints.fingerprint}) < (${cursor.bannedAt.toISOString()}::timestamptz, ${cursor.fingerprint}::uuid)`
        )
      : query;
    const rows = await withCursor
      .orderBy(
        sql`date_trunc('milliseconds', ${banned_fingerprints.banned_at}) DESC`,
        desc(banned_fingerprints.fingerprint)
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? `${last.banned_at.toISOString()}|${last.fingerprint}` : null;

    return res.status(200).json({ items, nextCursor });
  } catch (error) {
    console.error('[INTERNAL BANS] GET error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
