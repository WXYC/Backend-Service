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
import { eq, desc, sql } from 'drizzle-orm';
import { db, banned_fingerprints } from '@wxyc/database';

const ROM_INTERNAL_KEY = process.env.ROM_INTERNAL_KEY ?? '';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const internalBansRoute = Router();

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

  // bannedByUserId is optional. Reject wrong-type values so operator typos
  // surface as 400 rather than silently dropping attribution to NULL.
  let bannedByUserId: string | null = null;
  if (body.bannedByUserId !== undefined && body.bannedByUserId !== null) {
    if (typeof body.bannedByUserId !== 'string') {
      return res.status(400).json({ error: 'bannedByUserId must be a string when provided' });
    }
    bannedByUserId = body.bannedByUserId;
  }

  try {
    // Idempotent upsert: on conflict, refresh the mutable fields (reason,
    // expiry, actor) AND advance `banned_at` to now() so the GET listing's
    // ORDER BY banned_at DESC surfaces re-bans as recent activity. Operators
    // re-banning a fingerprint typically want the row to bubble to the top
    // for an eventual UI; preserving the original `banned_at` would bury it.
    const rows = await db
      .insert(banned_fingerprints)
      .values({
        fingerprint: body.fingerprint,
        ban_reason: body.reason,
        ban_expires_at: banExpiresAt,
        banned_by_user_id: bannedByUserId,
      })
      .onConflictDoUpdate({
        target: banned_fingerprints.fingerprint,
        set: {
          ban_reason: sql`excluded.ban_reason`,
          ban_expires_at: sql`excluded.ban_expires_at`,
          banned_by_user_id: sql`excluded.banned_by_user_id`,
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
    await db
      .delete(banned_fingerprints)
      .where(eq(banned_fingerprints.fingerprint, fingerprint))
      .returning({ fingerprint: banned_fingerprints.fingerprint });
    return res.status(204).end();
  } catch (error) {
    console.error('[INTERNAL BANS] DELETE error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- GET /internal/banned-fingerprints?limit=&cursor= ----
// Keyset-paginated list ordered by (banned_at DESC, fingerprint DESC).
// Cursor is "<iso_timestamp>|<fingerprint_uuid>" — a composite tiebreaker
// so two rows sharing the same `banned_at` (sub-millisecond writes, bulk
// loads) don't get skipped at the page boundary. The predicate is
// `(banned_at, fingerprint) < (?, ?)` in Postgres row-comparison form.
// Default limit 50, max 200.
internalBansRoute.get('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

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
    // Row-comparison `(a, b) < (?, ?)` is Postgres's native composite
    // keyset-pagination operator; planner picks the (banned_at, fingerprint)
    // index path when one exists. There isn't one yet — fingerprint is the
    // PK and banned_at has no index — but for the expected operator-scale
    // volume the sort+filter pays trivially. Add a (banned_at DESC,
    // fingerprint DESC) index when row count grows past a few thousand.
    const query = db.select().from(banned_fingerprints);
    const withCursor = cursor
      ? query.where(
          sql`(${banned_fingerprints.banned_at}, ${banned_fingerprints.fingerprint}) < (${cursor.bannedAt}, ${cursor.fingerprint}::uuid)`
        )
      : query;
    const rows = await withCursor
      .orderBy(desc(banned_fingerprints.banned_at), desc(banned_fingerprints.fingerprint))
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
