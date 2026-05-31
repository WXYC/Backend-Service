/**
 * POST /auth/check-request-ban (BS#1261).
 *
 * Called by request-o-matic on every `POST /request` to decide whether to
 * allow or block. See WXYC/Backend-Service#1261 for the architecture record.
 *
 * Inputs (per the issue spec):
 *   Authorization: Bearer <jwt>      (optional)
 *   X-Device-Fingerprint: <uuid>     (optional)
 * At least one of the two must be present; otherwise 400 no_signal.
 *
 * Resolution model:
 *   - Verify the JWT in-process via `auth.api.verifyJWT` (JWKS-backed; no HTTP
 *     hop). If the JWT is present but invalid → 401 invalid_token. If the
 *     JWT verifies but the `sub` user has been deleted → 404 user_not_found.
 *   - Check the fingerprint against `banned_fingerprints`, filtering out
 *     rows whose `ban_expires_at` is in the past.
 *   - If both signals are banned, return `banSource: "fingerprint"` — the
 *     stickier ban and the more meaningful operator signal.
 *
 * Never log the raw JWT body — logged JWTs are credentials. Logging is keyed
 * on `userId` extracted from claims.
 */

import * as Sentry from '@sentry/node';
import type { Request, Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db, banned_fingerprints, user } from '@wxyc/database';
import { auth } from '@wxyc/authentication';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

type UserBanRow = { id: string; banned: boolean | null; banReason: string | null };
type FingerprintBanRow = { fingerprint: string; ban_reason: string; ban_expires_at: Date | null };

async function lookupUser(userId: string): Promise<UserBanRow | null> {
  const rows = await db
    .select({ id: user.id, banned: user.banned, banReason: user.banReason })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

async function lookupFingerprint(fingerprint: string): Promise<FingerprintBanRow | null> {
  const rows = await db
    .select({
      fingerprint: banned_fingerprints.fingerprint,
      ban_reason: banned_fingerprints.ban_reason,
      ban_expires_at: banned_fingerprints.ban_expires_at,
    })
    .from(banned_fingerprints)
    .where(
      sql`${banned_fingerprints.fingerprint} = ${fingerprint}::uuid AND (${banned_fingerprints.ban_expires_at} IS NULL OR ${banned_fingerprints.ban_expires_at} > now())`
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function checkRequestBanHandler(req: Request, res: Response): Promise<Response> {
  try {
    const authHeader = req.get('Authorization');
    const bearer = extractBearer(authHeader);
    const fingerprintRaw = req.get('X-Device-Fingerprint');

    // Authorization present but unparseable as Bearer → 401 (they tried to
    // authenticate and the header is malformed). Distinct from "no header at
    // all" which is treated as the JWT-absent path.
    if (authHeader && !bearer) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    if (!bearer && !fingerprintRaw) {
      return res.status(400).json({ error: 'no_signal' });
    }

    if (fingerprintRaw && !UUID_REGEX.test(fingerprintRaw)) {
      return res.status(400).json({ error: 'invalid_fingerprint' });
    }
    const fingerprint = fingerprintRaw ?? null;

    // Verify the JWT (if present). better-auth's verifyJWT returns
    // `{ payload: null }` on any failure (bad signature, expired, malformed).
    // We can't distinguish expired from invalid here without parsing claims
    // ourselves; the spec accepts a single "invalid_token" classification for
    // both cases.
    let userId: string | null = null;
    if (bearer) {
      // tsup's DTS emitter narrows `auth.api` to better-auth's base endpoints
      // and loses the JWT plugin's `verifyJWT` (same pattern as the comment in
      // shared/authentication/src/auth.definition.ts on the `auth` export
      // itself). The runtime API is present — cast through `unknown` to a
      // narrow typed surface for just the method we use.
      const api = auth.api as unknown as {
        verifyJWT: (input: { body: { token: string } }) => Promise<{ payload: { sub?: string } | null }>;
      };
      const { payload } = await api.verifyJWT({ body: { token: bearer } });
      if (!payload || !payload.sub) {
        return res.status(401).json({ error: 'invalid_token' });
      }
      userId = payload.sub;
    }

    // Look up user + fingerprint in parallel when both are present.
    const [userRow, fingerprintRow] = await Promise.all([
      userId ? lookupUser(userId) : Promise.resolve(null),
      fingerprint ? lookupFingerprint(fingerprint) : Promise.resolve(null),
    ]);

    if (userId && !userRow) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const userBanned = !!userRow?.banned;
    const fingerprintBanned = !!fingerprintRow;

    if (fingerprintBanned) {
      return res.status(200).json({
        userId,
        fingerprint,
        banned: true,
        banReason: fingerprintRow!.ban_reason,
        banSource: 'fingerprint',
      });
    }

    if (userBanned) {
      return res.status(200).json({
        userId,
        fingerprint,
        banned: true,
        banReason: userRow!.banReason,
        banSource: 'user',
      });
    }

    return res.status(200).json({ userId, fingerprint, banned: false });
  } catch (error) {
    console.error('[CHECK REQUEST BAN] Unexpected error:', error);
    Sentry.captureException(error, { tags: { subsystem: 'check-request-ban' } });
    return res.status(500).json({ error: 'internal_server_error' });
  }
}
