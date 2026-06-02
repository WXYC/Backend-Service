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
 * Resolution order matters: the fingerprint side is checked FIRST so a
 * banned-fingerprint caller cannot bypass enforcement by appending a
 * malformed JWT to force a 401 short-circuit. If both signals are present
 * and the fingerprint is banned, the response is 200 banned regardless of
 * JWT validity. The JWT is only verified (and 401 returned on failure)
 * when the fingerprint side did not produce a banned answer.
 *
 * Expired bans (user-side or fingerprint-side) are treated as not-banned.
 * better-auth only auto-clears expired user.banned at session.create.before
 * (next sign-in), so a stale JWT issued before the expiry would otherwise
 * keep returning banned indefinitely — read banExpires here and honor it.
 *
 * Never log the raw JWT body — logged JWTs are credentials. Logging is
 * keyed on userId extracted from claims.
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

type UserBanRow = {
  id: string;
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
};
type FingerprintBanRow = { fingerprint: string; ban_reason: string; ban_expires_at: Date | null };

async function lookupUser(userId: string): Promise<UserBanRow | null> {
  const rows = await db
    .select({
      id: user.id,
      banned: user.banned,
      banReason: user.banReason,
      banExpires: user.banExpires,
    })
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

function isUserCurrentlyBanned(row: UserBanRow): boolean {
  if (!row.banned) return false;
  if (row.banExpires && row.banExpires.getTime() <= Date.now()) return false;
  return true;
}

export async function checkRequestBanHandler(req: Request, res: Response): Promise<Response> {
  try {
    const authHeader = req.get('Authorization');
    const bearer = extractBearer(authHeader);
    const fingerprintRaw = req.get('X-Device-Fingerprint');

    // Authorization present but unparseable as Bearer is a malformed JWT —
    // hold the 401 until after the fingerprint check so a banned-fingerprint
    // caller can't bypass by appending garbage to the Authorization header.
    const authHeaderMalformed = !!authHeader && !bearer;

    if (!bearer && !fingerprintRaw && !authHeaderMalformed) {
      return res.status(400).json({ error: 'no_signal' });
    }

    if (fingerprintRaw && !UUID_REGEX.test(fingerprintRaw)) {
      return res.status(400).json({ error: 'invalid_fingerprint' });
    }
    const fingerprint = fingerprintRaw ?? null;

    // Resolve the fingerprint first. If it's banned, the answer is "banned"
    // regardless of JWT validity — that's the whole point of the
    // fingerprint-as-stable-ban-target architecture.
    const fingerprintRow = fingerprint ? await lookupFingerprint(fingerprint) : null;
    if (fingerprintRow) {
      return res.status(200).json({
        userId: null,
        fingerprint,
        banned: true,
        banReason: fingerprintRow.ban_reason,
        banSource: 'fingerprint',
      });
    }

    // Fingerprint is clean (or absent). Now the JWT side becomes load-bearing
    // for a "banned: false" verdict — a malformed/invalid JWT must produce
    // 401 here so callers can't get a "not banned" response from a bad token.
    if (authHeaderMalformed) {
      return res.status(401).json({ error: 'invalid_token' });
    }

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

    if (!userId) {
      // Fingerprint-only request, fingerprint not banned → not banned.
      return res.status(200).json({ userId: null, fingerprint, banned: false });
    }

    const userRow = await lookupUser(userId);
    if (!userRow) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    if (isUserCurrentlyBanned(userRow)) {
      return res.status(200).json({
        userId,
        fingerprint,
        banned: true,
        banReason: userRow.banReason,
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
