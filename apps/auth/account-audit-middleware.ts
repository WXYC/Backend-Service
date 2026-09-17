/**
 * The account-audit Express decorator (BS#2537, parent epic #2534). Two
 * constructors share one implementation: `adminPrefixAuditMiddleware()` for
 * the `/auth/admin` prefix (action derived per-request from the path) and
 * `flatMountAuditMiddleware(mount)` for one exact `FlatMount` from
 * `./audit-coverage.ts`. Both call `recordAccountAuditEvent` fire-and-forget
 * from `res.on('finish'|'close')`, after the response is already sent — the
 * write cannot be awaited by the request path because there is nothing left
 * to fail closed against (parent epic decision 2/7).
 */
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { auth, deriveStationSignupIpHash } from '@wxyc/authentication';
import { db, recordAccountAuditEvent, user } from '@wxyc/database';
import { fromNodeHeaders } from 'better-auth/node';
import { ADMIN_ACTION_BY_PATH, ADMIN_GET_INCLUDES, ADMIN_PREFIX, type FlatMount } from './audit-coverage.js';

const MAX_BODY_CAPTURE_BYTES = 4096;

/** better-auth's own `generateId()` default (shared/authentication/src/auth.definition.ts's `generateId(32)` call) is a 32-char a-zA-Z0-9 string. */
const BETTER_AUTH_ID_LENGTH = 32;

const onAuditError = (error: unknown): void => {
  Sentry.captureException(error, { tags: { subsystem: 'account-audit' } });
};

/**
 * Coarse shape guard (L3, code review BS#2537 PR #2545), not a format
 * validator: a body-supplied `userId` is caller-controlled input, and
 * `subject_user_id` must never carry PII (the same constraint AC#3 enforces
 * for `forget-password`'s email lookup). Rejects anything containing '@'
 * (an email slipped into the wrong field) or implausibly long for a real
 * better-auth id, without trying to validate the id actually exists.
 */
const isPlausibleUserId = (value: string): boolean =>
  value.length > 0 && value.length <= BETTER_AUTH_ID_LENGTH && !value.includes('@');

/** Best-effort, per decision 12: a string `userId` field where the body has one, else NULL. */
const extractBodyUserId = (req: Request): string | null => {
  const value = (req.body as Record<string, unknown> | undefined)?.userId;
  return typeof value === 'string' && isPlausibleUserId(value) ? value : null;
};

/**
 * The one DB read this middleware performs directly: resolve a submitted
 * email to a user id for `forget-password`, so the email string itself never
 * lands in `account_audit_event` (AC#3). Errors are swallowed to NULL —
 * failing to resolve a subject must never affect the response or the write.
 */
const resolveUserIdByEmail = async (email: unknown): Promise<string | null> => {
  if (typeof email !== 'string' || email.length === 0) return null;
  try {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    return rows[0]?.id ?? null;
  } catch (error) {
    onAuditError(error);
    return null;
  }
};

/** Self-service mounts where the caller's own account is both actor and subject. */
const SELF_ACTIONS: ReadonlySet<string> = new Set(['change-password', 'change-email', 'update-user', 'delete-user']);

const ipHashOf = (req: Request): string | null => {
  const raw = req.headers['x-real-ip'];
  return deriveStationSignupIpHash(Array.isArray(raw) ? raw[0] : raw);
};

interface ResolvedMount {
  action: (req: Request) => string;
  resolveActor: boolean;
  /** Public mounts (resolveActor:false) gate this to 2xx outcomes — decision 12's DoS-amplifier guard. */
  subjectFrom: (req: Request, actorId: string | null) => Promise<string | null>;
  /** GET requests are skipped unless this returns true (decision 3). */
  includeGet: (req: Request) => boolean;
  /**
   * M2 (code review BS#2537 PR #2545): omitted (or true) for every
   * `FlatMount` — each is mounted at its own literal path, so any request
   * this middleware instance ever sees already IS that one known action.
   * `adminPrefixAuditMiddleware` supplies this because the whole point of a
   * PREFIX mount is that it sees paths it doesn't recognize; without this
   * gate, any anonymous request to `/auth/admin/<garbage>` cost a
   * getSession read + an INSERT and minted an attacker-controlled action
   * slug from raw path text.
   */
  isKnown?: (req: Request) => boolean;
}

function auditMiddleware(resolve: ResolvedMount) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS' || req.method === 'HEAD') return next();
    if (resolve.isKnown && !resolve.isKnown(req)) return next();
    if (req.method === 'GET' && !resolve.includeGet(req)) return next();

    const action = resolve.action(req);
    const ipHash = ipHashOf(req);

    const capturedBody: Buffer[] = [];
    let capturedBytes = 0;
    const capture = (chunk: unknown): void => {
      if (res.statusCode < 400 || capturedBytes >= MAX_BODY_CAPTURE_BYTES) return;
      // HIGH 2 (code review BS#2537 PR #2545): better-call's setResponse
      // pumps `response.body.getReader()` values into res.write(value) as
      // plain Uint8Array chunks — Buffer.isBuffer is false for those, so
      // the old `typeof chunk !== 'string' && !Buffer.isBuffer(chunk)`
      // guard silently dropped every better-auth ≥400 body and error_code
      // stayed NULL for the whole better-auth surface. Buffer IS a
      // Uint8Array subclass, so `instanceof Uint8Array` subsumes both.
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return;
      let buf: Buffer;
      if (typeof chunk === 'string') buf = Buffer.from(chunk);
      else if (Buffer.isBuffer(chunk)) buf = chunk;
      // A non-Buffer Uint8Array view can be a slice of a larger shared
      // ArrayBuffer, so respect its own byteOffset/byteLength rather than
      // assuming the whole underlying buffer belongs to this chunk.
      else buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      // L2: truncate the chunk that crosses the cap rather than only
      // checking it beforehand — without this, a single chunk arriving
      // near the boundary could push capturedBytes past MAX_BODY_CAPTURE_BYTES.
      const remaining = MAX_BODY_CAPTURE_BYTES - capturedBytes;
      if (buf.length > remaining) buf = buf.subarray(0, remaining);
      capturedBody.push(buf);
      capturedBytes += buf.length;
    };
    // better-call's node adapter (the layer toNodeHandler(auth) delegates
    // to) writes response bodies via raw res.write/res.end — never
    // res.json, which funnels into res.end anyway and needs no separate
    // wrap. Typed via Parameters<> rather than `any` so the wrap stays
    // type-checked against Express's own overloads.
    const origWrite = res.write.bind(res);
    res.write = ((...args: Parameters<Response['write']>) => {
      capture(args[0]);
      return origWrite(...args);
    }) as Response['write'];
    const origEnd = res.end.bind(res);
    res.end = ((...args: Parameters<Response['end']>) => {
      if (args[0] !== undefined) capture(args[0]);
      return origEnd(...args);
    }) as Response['end'];

    let actorId: string | null = null;
    let impersonatorId: string | null = null;

    const finishOnce = ((): (() => void) => {
      let logged = false;
      return () => {
        if (logged) return;
        logged = true;

        // M1 (code review BS#2537 PR #2545): Node's default res.statusCode
        // is 200 before any status is ever set, so a 'close' that fires
        // WITHOUT a prior 'finish' (the request aborted mid-flight — client
        // disconnect, etc.) would otherwise fabricate an outcome=200 row
        // and wrongly satisfy the public-mount 2xx subject-resolution gate
        // below for a request that never actually completed.
        // res.writableFinished is Node's own signal that 'finish' genuinely
        // fired (true immediately before 'finish' is emitted) — skip the
        // row entirely when it's false rather than guess at, or invent a
        // sentinel for, an outcome the request never reached. `outcome` is
        // documented as "raw HTTP status", so a synthetic value (e.g. a
        // 499-style convention) would misrepresent what the column means.
        if (!res.writableFinished) return;

        let errorCode: string | null = null;
        if (res.statusCode >= 400 && capturedBody.length > 0) {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(capturedBody).toString('utf8'));
            const code = (parsed as { code?: unknown } | null)?.code;
            if (typeof code === 'string') errorCode = code;
          } catch {
            /* not JSON, or truncated at the 4KB cap — no code, not an error */
          }
        }

        // Public mounts (resolveActor:false) gate subject resolution to 2xx —
        // the finish handler fires on 429s too, and an ungated lookup would
        // hand a distributed brute force one DB read per throttled attempt.
        const subjectPromise =
          resolve.resolveActor || res.statusCode < 300 ? resolve.subjectFrom(req, actorId) : Promise.resolve(null);

        void subjectPromise
          .then((subjectUserId) =>
            recordAccountAuditEvent(
              {
                action,
                actorUserId: actorId,
                impersonatorUserId: impersonatorId,
                subjectUserId,
                outcome: res.statusCode,
                errorCode,
                ipHash,
                source: 'http',
              },
              { onError: onAuditError }
            )
          )
          .catch(onAuditError);
      };
    })();
    res.on('finish', finishOnce);
    res.on('close', finishOnce);

    if (!resolve.resolveActor) return next();

    auth.api
      .getSession({ headers: fromNodeHeaders(req.headers) })
      .then((session) => {
        actorId = session?.user?.id ?? null;
        impersonatorId = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy ?? null;
      })
      .catch(onAuditError)
      .finally(() => next());
  };
}

/** `/auth/admin/*` — every non-GET request, plus the named PII-bulk-read GETs. Action is path-derived. */
export function adminPrefixAuditMiddleware() {
  // HIGH 1 (code review BS#2537 PR #2545): Express 5 strips the mount path
  // under `app.use('/auth/admin', middleware)` — a request to
  // /auth/admin/set-role arrives here with req.path === '/set-role' (and
  // req.baseUrl === '/auth/admin'), never '/admin/set-role'. This mount is
  // registered exactly once (app.ts), so ADMIN_PREFIX + req.path
  // reconstructs the bare canonical path audit-coverage.ts's tables key on.
  const canonicalPath = (req: Request): string => ADMIN_PREFIX + req.path;
  return auditMiddleware({
    // The slug now comes from a lookup, not a transform of request text —
    // both HIGH 1 (the old transform silently produced 'set-role' instead
    // of 'admin.set-role', colliding e.g. admin.update-user with the
    // self-service update-user action) and M2 (a lookup miss means "not a
    // known action" and is caught by isKnown below, so an unknown path can
    // never mint an action string from attacker-controlled path text).
    action: (req) => ADMIN_ACTION_BY_PATH.get(canonicalPath(req)) ?? '',
    resolveActor: true,
    subjectFrom: (req) => Promise.resolve(extractBodyUserId(req)),
    includeGet: (req) => ADMIN_GET_INCLUDES.has(canonicalPath(req)),
    isKnown: (req) => ADMIN_ACTION_BY_PATH.has(canonicalPath(req)),
  });
}

/** One exact `FlatMount` — the mount and its subject-resolution strategy. */
export function flatMountAuditMiddleware(mount: FlatMount) {
  const subjectFrom = (req: Request, actorId: string | null): Promise<string | null> => {
    if (mount.action === 'forget-password') {
      return resolveUserIdByEmail((req.body as Record<string, unknown> | undefined)?.email);
    }
    if (SELF_ACTIONS.has(mount.action)) return Promise.resolve(actorId);
    return Promise.resolve(extractBodyUserId(req));
  };
  return auditMiddleware({
    action: () => mount.action,
    resolveActor: mount.resolveActor,
    subjectFrom,
    includeGet: () => false, // every FlatMount is a POST-only mutation; a stray GET 404s unlogged.
  });
}
