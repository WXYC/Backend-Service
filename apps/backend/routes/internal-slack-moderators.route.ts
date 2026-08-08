/**
 * /internal/slack-ban-moderators (BS#2045).
 *
 * Durable roster of Slack users authorized to ban request-line abusers,
 * replacing request-o-matic's `SLACK_BAN_AUTHORIZED_USERS` env var — a
 * comma-separated list duplicated across ROM's two Railway environments that
 * needed a full redeploy to edit. ROM owns the operator UX (the
 * `/request-mods` modal, WXYC/request-o-matic#240); this service owns the
 * storage, exactly as it does for `banned_fingerprints`.
 *
 * Same `X-Internal-Key` / `ROM_INTERNAL_KEY` gate as the structural donor at
 * `internal-bans.route.ts` — same caller, same blast radius, so no new secret.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asc, notInArray, sql } from 'drizzle-orm';
import { db, slack_ban_moderators } from '@wxyc/database';

const ROM_INTERNAL_KEY = process.env.ROM_INTERNAL_KEY ?? '';

/**
 * Advisory-lock key serializing concurrent `PUT`s (see the transaction below).
 *
 * MUST stay distinct from `jobs/legacy-mirror-reconcile/job.ts`'s
 * `ADVISORY_LOCK_KEY = 17071707`, the only other advisory lock in this
 * codebase. Single-bigint `pg_try_advisory_lock` and `pg_advisory_xact_lock`
 * share one lock space database-wide, so reusing that number would make a
 * roster save block behind the mirror-reconcile cron and fail at
 * `statement_timeout` with SQLSTATE 57014 instead of saving.
 *
 * The value is the date this key was allocated (2026-08-08); arbitrary but
 * stable, and self-documenting about which of the two came second.
 */
export const SLACK_MODERATORS_ADVISORY_LOCK_KEY = 20260808;

// Slack user IDs are canonically uppercase alphanumeric (`U…` / `W…`).
const SLACK_USER_ID_REGEX = /^[A-Z0-9]+$/i;

// slack_user_id / added_by_slack_user_id are varchar(64); reject longer
// inputs at the route layer rather than waiting for Postgres to raise a
// string-length error and surface as a 500. Same rule the donor records for
// `bannedByUserId` (internal-bans.route.ts:29-31).
const MAX_SLACK_USER_ID_LENGTH = 64;

// Matches Slack's `multi_users_select` `initial_users` ceiling, which is the
// real-world bound on this list. Also caps an unbounded array on a key-gated
// endpoint — a soft DoS surface if ROM_INTERNAL_KEY leaks (same argument as
// the donor's MAX_REASON_LENGTH).
const MAX_MODERATORS = 100;

const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Per-IP rate limit, copied from the sibling internal route rather than
// reinvented. Roster edits are a few writes a year, so this ceiling is
// nowhere near operator volume; it bounds the blast radius if the key leaks.
// Disabled in dev/test to keep integration suites deterministic.
const internalSlackModeratorsRateLimit = isDevOrTest
  ? (_req: unknown, _res: unknown, next: () => void) => next()
  : rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    });

export const internalSlackModeratorsRoute = Router();
internalSlackModeratorsRoute.use(internalSlackModeratorsRateLimit);

function authenticateInternal(key: string | undefined): boolean {
  return !!ROM_INTERNAL_KEY && key === ROM_INTERNAL_KEY;
}

/**
 * Normalize a caller-supplied ID list to the canonical comparison form:
 * **uppercase, deduplicated, sorted.**
 *
 * The `expectedCurrent` comparison is only meaningful if both sides normalize
 * identically. Slack IDs are canonically uppercase, so treating `u0…` and
 * `U0…` as different members would 409 an edit that changed nothing — worse
 * than the race the check exists to catch. ROM normalizes before sending;
 * this service normalizes on both write and compare.
 *
 * Returns an error string instead of throwing so the caller can attribute it
 * to the right field name in the 400.
 */
function normalizeSlackUserIds(value: unknown, field: string): { ids: string[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: `${field} must be an array of Slack user IDs` };
  }
  if (value.length > MAX_MODERATORS) {
    return { error: `${field} must contain at most ${MAX_MODERATORS} Slack user IDs` };
  }
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { error: `${field} must contain only strings` };
    }
    if (entry.length === 0 || entry.length > MAX_SLACK_USER_ID_LENGTH) {
      return { error: `${field} entries must be between 1 and ${MAX_SLACK_USER_ID_LENGTH} characters` };
    }
    if (!SLACK_USER_ID_REGEX.test(entry)) {
      return { error: `${field} entries must be alphanumeric Slack user IDs` };
    }
  }
  const ids = [...new Set((value as string[]).map((id) => id.toUpperCase()))].sort();
  return { ids };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

const orderedModerators = () =>
  db
    .select()
    .from(slack_ban_moderators)
    .orderBy(asc(slack_ban_moderators.added_at), asc(slack_ban_moderators.slack_user_id));

// ---- GET /internal/slack-ban-moderators ----
//
// Returns the FULL set — deliberately unpaginated, unlike the keyset-paginated
// sibling at /internal/banned-fingerprints. That table grows without bound;
// this one is bounded by the size of the WXYC exec staff (tens of rows,
// forever) and by Slack's 100-entry `initial_users` cap on the modal that
// consumes it. Don't "fix" this into a paginated endpoint.
//
// The `slack_user_id` tiebreak on the ORDER BY is load-bearing: `added_at`
// defaults to now(), which is transaction-start time, so everyone added in a
// single save shares one timestamp. Without the tiebreak their relative order
// is whatever Postgres happens to return, and the modal's `initial_users`
// would flap between renders of an unchanged roster.
internalSlackModeratorsRoute.get('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const items = await orderedModerators();
    return res.status(200).json({ items });
  } catch (error) {
    console.error('[SLACK MODERATORS] GET error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- PUT /internal/slack-ban-moderators ----
//
// Replaces the whole set. A Slack `multi_users_select` submits the complete
// desired roster rather than a delta, so a set-replace maps exactly onto the
// UI and is idempotent; per-user POST/DELETE would force ROM to diff against
// a list it read seconds earlier, which is more code for the same race.
//
// `expectedCurrent` is the sorted set ROM read when it opened the modal,
// round-tripped through the modal's `private_metadata`. A mismatch is a 409:
// two moderators editing in the same minute is rare, but last-write-wins
// silently discards one person's edit and nothing surfaces it.
internalSlackModeratorsRoute.put('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = (req.body ?? {}) as {
    slackUserIds?: unknown;
    expectedCurrent?: unknown;
    actorSlackUserId?: unknown;
  };

  const desiredResult = normalizeSlackUserIds(body.slackUserIds, 'slackUserIds');
  if ('error' in desiredResult) {
    return res.status(400).json({ error: desiredResult.error });
  }
  const expectedResult = normalizeSlackUserIds(body.expectedCurrent, 'expectedCurrent');
  if ('error' in expectedResult) {
    return res.status(400).json({ error: expectedResult.error });
  }
  const desired = desiredResult.ids;
  const expected = expectedResult.ids;

  // Optional, which is exactly why it's easy to forget to validate: it lands
  // in varchar(64), so a non-string or over-long value would reach Postgres
  // and surface as a 500 rather than an actionable 400.
  let actor: string | null = null;
  if (body.actorSlackUserId !== undefined && body.actorSlackUserId !== null) {
    if (typeof body.actorSlackUserId !== 'string') {
      return res.status(400).json({ error: 'actorSlackUserId must be a string when provided' });
    }
    if (body.actorSlackUserId.length === 0 || body.actorSlackUserId.length > MAX_SLACK_USER_ID_LENGTH) {
      return res
        .status(400)
        .json({ error: `actorSlackUserId must be between 1 and ${MAX_SLACK_USER_ID_LENGTH} characters` });
    }
    if (!SLACK_USER_ID_REGEX.test(body.actorSlackUserId)) {
      return res.status(400).json({ error: 'actorSlackUserId must be an alphanumeric Slack user ID' });
    }
    actor = body.actorSlackUserId.toUpperCase();
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // FIRST statement, before the comparison — and a transaction alone is
      // not a substitute. Under READ COMMITTED two concurrent PUTs can both
      // read the same live set, both pass the expectedCurrent check, and only
      // then serialize their writes: the second transaction's DELETE took its
      // snapshot before the first committed, so it cannot see the rows the
      // first inserted and the table ends up holding the UNION of two edits
      // that each believed they had replaced it — the exact silent-merge the
      // 409 exists to prevent, with the 409 never firing.
      //
      // `SELECT ... FOR UPDATE` is not a substitute either: the conflicting
      // write may be an INSERT of a row that does not yet exist, so there is
      // nothing to lock. The transaction-scoped (_xact_) variant releases on
      // commit or rollback, with no cleanup path to get wrong — and it can't
      // hit the connection-recycling hazard documented at
      // shared/database/src/client.ts:109 that the session-scoped variant can.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SLACK_MODERATORS_ADVISORY_LOCK_KEY}::bigint)`);

      const currentRows = await tx
        .select()
        .from(slack_ban_moderators)
        .orderBy(asc(slack_ban_moderators.added_at), asc(slack_ban_moderators.slack_user_id));
      const current = [...new Set(currentRows.map((r) => r.slack_user_id.toUpperCase()))].sort();

      if (!sameSet(current, expected)) {
        return { conflict: true as const, current };
      }

      const added = desired.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !desired.includes(id));

      // Differential replace, NOT a wholesale DELETE + INSERT — a correctness
      // requirement, not an optimization. Rewriting every row on every save
      // would falsify both audit columns this table exists to carry:
      // `added_by_slack_user_id` would degrade to "whoever last hit Save" for
      // members added years earlier, and `added_at` (transaction-start time)
      // would collapse to one identical timestamp across all rows, leaving
      // GET's ORDER BY sorting by nothing. A save that removes one person
      // would rewrite the provenance of everyone else.
      //
      // An empty `desired` is legal — it means "no moderators" — and the
      // DELETE handles it correctly, since drizzle's notInArray([]) emits
      // `true`. The INSERT does not: `.values([])` raises rather than
      // emitting a no-op, so the one legal request that empties the table
      // would 500 on the way out without this guard.
      await tx.delete(slack_ban_moderators).where(notInArray(slack_ban_moderators.slack_user_id, desired));
      if (desired.length > 0) {
        await tx
          .insert(slack_ban_moderators)
          .values(desired.map((id) => ({ slack_user_id: id, added_by_slack_user_id: actor })))
          // Idempotent against members who were already there — the common
          // case, since most saves add or remove one person and leave the
          // rest untouched. This is also what preserves their audit columns.
          .onConflictDoNothing();
      }

      const items = await tx
        .select()
        .from(slack_ban_moderators)
        .orderBy(asc(slack_ban_moderators.added_at), asc(slack_ban_moderators.slack_user_id));

      return { conflict: false as const, items, added, removed };
    });

    if (outcome.conflict) {
      return res.status(409).json({
        error: 'Moderator roster changed since it was read; re-open the picker and try again',
        current: outcome.current,
      });
    }

    // A removal deletes its row and leaves nothing behind, and a privilege
    // revocation is at least as interesting after the fact as a grant — so
    // the diff is logged. It's computed from the same comparison that drove
    // the two statements above, so it describes what the transaction actually
    // did rather than restating the request. A durable audit table would be a
    // larger design question; a log line is proportionate for a roster that
    // changes a few times a year.
    console.log('[SLACK MODERATORS] roster replaced', {
      actor: actor ?? '<none>',
      added: outcome.added,
      removed: outcome.removed,
      total: outcome.items.length,
    });

    return res.status(200).json({ items: outcome.items });
  } catch (error) {
    console.error('[SLACK MODERATORS] PUT error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
