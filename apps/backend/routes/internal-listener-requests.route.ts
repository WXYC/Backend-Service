/**
 * /internal/listener-requests create and list (BS#2662).
 *
 * Two endpoints for request-o-matic's DJ-reply flow. POST runs before ROM
 * posts a request to Slack, so the post's replyability marker is truthful the
 * moment it renders; GET feeds the `/reply` slash command one pre-filtered,
 * ordered, capped read. Each endpoint gates on `X-Internal-Key` matched
 * against `ROM_INTERNAL_KEY`, the same caller and key as
 * `internal-bans.route.ts`.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, listener_requests, listener_request_replies, extractSqlState, requirePositiveInt } from '@wxyc/database';

const ROM_INTERNAL_KEY = process.env.ROM_INTERNAL_KEY ?? '';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Column widths of listener_requests.slack_channel_id and auth_user.id; reject
// longer inputs here rather than surface a string-length error as a 500.
const MAX_CHANNEL_ID_LENGTH = 64;
const MAX_USER_ID_LENGTH = 255;

const DEFAULT_REPLY_WINDOW_MINUTES = 30;

// The only caller is a Slack command on a ~3 second trigger_id budget, so the
// cap is the contract and there is no limit parameter.
const LIST_LIMIT = 20;

const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Per-IP rate limit; disabled in dev/test to keep suites deterministic
// (mirrors internal-bans.route.ts).
const internalListenerRequestsRateLimit = isDevOrTest
  ? (_req: unknown, _res: unknown, next: () => void) => next()
  : rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later.' },
    });

export const internalListenerRequestsRoute = Router();
internalListenerRequestsRoute.use(internalListenerRequestsRateLimit);

function authenticateInternal(key: string | undefined): boolean {
  return !!ROM_INTERNAL_KEY && key === ROM_INTERNAL_KEY;
}

// A request with an active reply is no longer answerable.
const hasNoActiveReply = sql`NOT EXISTS (
  SELECT 1 FROM ${listener_request_replies}
  WHERE ${listener_request_replies.request_id} = ${listener_requests.id}
    AND ${listener_request_replies.retracted_at} IS NULL
)`;

// ---- POST /internal/listener-requests ----
// `replyable` is this service's verdict: the request is addressable only when
// it carries the JWT anonymous user id. The fingerprint never makes a request
// replyable, because ROM publishes it in every Slack post.
internalListenerRequestsRoute.post('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = (req.body ?? {}) as {
    fingerprint?: unknown;
    anonymous_user_id?: unknown;
    slack_channel_id?: unknown;
  };

  if (typeof body.fingerprint !== 'string' || !UUID_REGEX.test(body.fingerprint)) {
    return res.status(400).json({ error: 'fingerprint must be a valid UUID' });
  }
  if (
    typeof body.slack_channel_id !== 'string' ||
    body.slack_channel_id.length === 0 ||
    body.slack_channel_id.length > MAX_CHANNEL_ID_LENGTH
  ) {
    return res
      .status(400)
      .json({ error: `slack_channel_id must be between 1 and ${MAX_CHANNEL_ID_LENGTH} characters` });
  }
  let anonymousUserId: string | null = null;
  if (body.anonymous_user_id !== undefined && body.anonymous_user_id !== null) {
    if (
      typeof body.anonymous_user_id !== 'string' ||
      body.anonymous_user_id.length === 0 ||
      body.anonymous_user_id.length > MAX_USER_ID_LENGTH
    ) {
      return res
        .status(400)
        .json({ error: `anonymous_user_id must be a string between 1 and ${MAX_USER_ID_LENGTH} characters` });
    }
    anonymousUserId = body.anonymous_user_id;
  }

  try {
    const windowMinutes = requirePositiveInt(
      process.env.LISTENER_REPLY_WINDOW_MINUTES,
      'LISTENER_REPLY_WINDOW_MINUTES',
      DEFAULT_REPLY_WINDOW_MINUTES
    );
    const rows = await db
      .insert(listener_requests)
      .values({
        fingerprint: body.fingerprint,
        anonymous_user_id: anonymousUserId,
        slack_channel_id: body.slack_channel_id,
        expires_at: new Date(Date.now() + windowMinutes * 60_000),
      })
      .returning({ id: listener_requests.id, expires_at: listener_requests.expires_at });

    const row = rows[0];
    if (!row) {
      return res.status(500).json({ error: 'Insert returned no row' });
    }
    return res.status(201).json({ id: row.id, expires_at: row.expires_at, replyable: anonymousUserId !== null });
  } catch (error) {
    // SQLSTATE 23503: well-formed anonymous_user_id that matches no auth_user
    // row. A caller error, not a server fault (see internal-bans.route.ts for
    // why extractSqlState looks at both `.cause.code` and `.code`).
    if (extractSqlState(error) === '23503') {
      return res.status(400).json({ error: 'anonymous_user_id does not reference an existing user' });
    }
    console.error('[INTERNAL LISTENER REQUESTS] POST error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- GET /internal/listener-requests?slack_channel_id=&replyable_for= ----
// The on-air window reads the stored `expires_at`, never `created_at` plus the
// configured window: a re-derived window would offer candidates that the
// send-time check then rejects once LISTENER_REPLY_WINDOW_MINUTES changes.
// Moderators are exempt from that window and may answer a hidden request.
internalListenerRequestsRoute.get('/', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { slack_channel_id: channelId, replyable_for: replyableFor } = req.query;
  if (typeof channelId !== 'string' || channelId.length === 0) {
    return res.status(400).json({ error: 'slack_channel_id must be a single string query param' });
  }
  if (replyableFor !== 'on_air' && replyableFor !== 'moderator') {
    return res.status(400).json({ error: 'replyable_for must be one of: on_air, moderator' });
  }

  const audiencePredicate =
    replyableFor === 'on_air'
      ? and(sql`${listener_requests.expires_at} > now()`, eq(listener_requests.status, 'posted'))
      : and(
          sql`${listener_requests.created_at} > now() - interval '24 hours'`,
          inArray(listener_requests.status, ['posted', 'hidden'])
        );

  try {
    const items = await db
      .select({
        id: listener_requests.id,
        slack_ts: listener_requests.slack_ts,
        created_at: listener_requests.created_at,
        expires_at: listener_requests.expires_at,
        status: listener_requests.status,
      })
      .from(listener_requests)
      .where(
        and(
          eq(listener_requests.slack_channel_id, channelId),
          isNotNull(listener_requests.anonymous_user_id),
          hasNoActiveReply,
          audiencePredicate
        )
      )
      .orderBy(desc(listener_requests.created_at))
      .limit(LIST_LIMIT);

    return res.status(200).json({ items });
  } catch (error) {
    console.error('[INTERNAL LISTENER REQUESTS] GET error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
