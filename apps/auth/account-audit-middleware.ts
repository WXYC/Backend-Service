/**
 * The account-audit Express decorator (BS#2537, parent epic #2534).
 * `adminPrefixAuditMiddleware()` covers the `/auth/admin` prefix (action
 * classified per-request from the path); `mountPublicAccountAudit(app)` /
 * `mountAuthenticatedAccountAudit(app)` each register ONE `/auth` layer
 * dispatching through a prebuilt `Map<path, mount middleware>` covering the
 * public/authenticated halves of `FLAT_MOUNTS` respectively (simplify pass,
 * code review BS#2537 PR #2545 follow-up — collapses what used to be one
 * `app.use` per `FlatMount`, ~20 Express layers, into two). All three call
 * `recordAccountAuditEvent` fire-and-forget from `res.on('finish'|'close')`,
 * after the response is already sent — the write cannot be awaited by the
 * request path because there is nothing left to fail closed against
 * (parent epic decision 2/7).
 */
import { eq } from 'drizzle-orm';
import type { Express, NextFunction, Request, Response } from 'express';
import { auth, deriveStationSignupIpHash } from '@wxyc/authentication';
import { db, recordAccountAuditEvent, user } from '@wxyc/database';
import { fromNodeHeaders } from 'better-auth/node';
import { onAccountAuditError } from './account-audit-error.js';
import { ADMIN_ACTIONS, ADMIN_PREFIX, FLAT_MOUNTS, type FlatMount } from './audit-coverage.js';
import { realIpFromRequest } from './rate-limit-key.js';

const MAX_BODY_CAPTURE_BYTES = 4096;

/** better-auth's own `generateId()` default (shared/authentication/src/auth.definition.ts's `generateId(32)` call) is a 32-char a-zA-Z0-9 string. */
const BETTER_AUTH_ID_LENGTH = 32;

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
 *
 * Simplify-pass disposition (item 12, code review BS#2537 PR #2545 follow-up):
 * `lookup-email.ts`/`station-signup.ts` resolve a user by a non-email field
 * via `(await auth.$context).adapter.findOne({ model: 'user', where: [...] })`
 * rather than a raw drizzle select, and that pattern was considered here.
 * KEPT the raw select instead: the shared `tests/mocks/authentication.mock.ts`
 * `auth` double has no `$context`, only `api.getSession` — switching this one
 * call site to `$context.adapter.findOne` would mean either adding `$context`
 * support to the shared mock (every other consumer of that mock would need
 * auditing for fallout) or giving this middleware's own test file a fully
 * local `jest.mock('@wxyc/authentication', ...)` factory that re-derives the
 * real re-exports (`deriveStationSignupIpHash`, per BS#1107) the shared mock
 * already provides. Both are disproportionate scaffolding for swapping one
 * already-tested, already-correct DB-access primitive with no behavior gain.
 */
const resolveUserIdByEmail = async (email: unknown): Promise<string | null> => {
  if (typeof email !== 'string' || email.length === 0) return null;
  try {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    return rows[0]?.id ?? null;
  } catch (error) {
    onAccountAuditError(error);
    return null;
  }
};

/**
 * Which `subjectFrom` strategy a `FlatMount` uses, selected ONCE at
 * `flatMountAuditMiddleware(mount)` construction time (simplify pass, item
 * 5) rather than re-branching on `mount.action` per request — replaces the
 * old `SELF_ACTIONS` set + `mount.action === 'forget-password'` compare.
 */
function subjectFromStrategy(mount: FlatMount): (req: Request, actorId: string | null) => Promise<string | null> {
  switch (mount.subject) {
    case 'email-lookup':
      return (req) => resolveUserIdByEmail((req.body as Record<string, unknown> | undefined)?.email);
    case 'actor':
      return (_req, actorId) => Promise.resolve(actorId);
    case 'body-user-id':
      return (req) => Promise.resolve(extractBodyUserId(req));
  }
}

const ipHashOf = (req: Request): string | null => deriveStationSignupIpHash(realIpFromRequest(req));

interface ResolvedMount {
  /**
   * Called once per request (item 6, code review BS#2537 PR #2545
   * follow-up — replaces three independent `action`/`includeGet`/`isKnown`
   * callbacks that each recomputed the canonical path). Returns `null` when
   * this request isn't a known/audited action at all — the M2 skip-before-
   * any-work gate for `adminPrefixAuditMiddleware`; every `FlatMount`
   * request is trivially known, since it's mounted at its own literal path.
   */
  classify: (req: Request) => { action: string; includeGet: boolean } | null;
  resolveActor: boolean;
  /** Public mounts (resolveActor:false) gate this to 2xx outcomes — decision 12's DoS-amplifier guard. */
  subjectFrom: (req: Request, actorId: string | null) => Promise<string | null>;
}

function auditMiddleware(resolve: ResolvedMount) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS' || req.method === 'HEAD') return next();
    const classified = resolve.classify(req);
    if (!classified) return next();
    if (req.method === 'GET' && !classified.includeGet) return next();

    const { action } = classified;

    const capturedBody: Buffer[] = [];
    let capturedBytes = 0;
    const capture = (chunk: unknown): void => {
      if (res.statusCode < 400 || capturedBytes >= MAX_BODY_CAPTURE_BYTES) return;
      // HIGH 2 (code review BS#2537 PR #2545): better-call's setResponse
      // pumps `response.body.getReader()` values into res.write(value) as
      // plain Uint8Array chunks — Buffer.isBuffer is false for those.
      // Buffer IS a Uint8Array subclass, so this two-arm ternary already
      // produces identical bytes for a real Buffer as the generic view
      // branch would (item 10 simplify pass) — string is the only shape
      // that needs its own conversion. A non-Buffer view can be a slice of
      // a larger shared ArrayBuffer, so Buffer.from respects its own
      // byteOffset/byteLength rather than assuming it owns the whole
      // underlying buffer.
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return;
      let buf: Buffer =
        typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
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
    // type-checked against Express's own overloads. capture() already
    // no-ops on anything that isn't a string or Uint8Array, so res.end's
    // wrapper needs no separate `args[0] !== undefined` guard (item 10) —
    // that covers both the no-body `res.end()` form and the callback-only
    // `res.end(callback)` form, where args[0] is a function.
    const origWrite = res.write.bind(res);
    res.write = ((...args: Parameters<Response['write']>) => {
      capture(args[0]);
      return origWrite(...args);
    }) as Response['write'];
    const origEnd = res.end.bind(res);
    res.end = ((...args: Parameters<Response['end']>) => {
      capture(args[0]);
      return origEnd(...args);
    }) as Response['end'];

    // Item 11 (simplify pass): a plain hoisted flag next to actorId/
    // impersonatorId rather than an IIFE-scoped closure — finishOnce is a
    // simple closure over this function's own locals.
    let logged = false;
    let actorId: string | null = null;
    let impersonatorId: string | null = null;

    // Item 8 (simplify pass): the session lookup starts here, BEFORE
    // next() — not awaited here, so the real handler is never serialized
    // behind it — and is awaited inside finishOnce, right before subject
    // resolution. `.catch` is attached immediately so a rejection can never
    // produce an unhandled rejection regardless of whether finishOnce ever
    // runs (an aborted request that never fires 'finish' still lets this
    // promise settle quietly). Do NOT assign actorId/impersonatorId on
    // resolve without awaiting in finishOnce — that would race the finish
    // event on whichever of getSession vs the real handler finishes first.
    const sessionPromise: Promise<void> | null = resolve.resolveActor
      ? auth.api
          .getSession({ headers: fromNodeHeaders(req.headers) })
          .then((session) => {
            actorId = session?.user?.id ?? null;
            impersonatorId =
              (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy ?? null;
          })
          .catch(onAccountAuditError)
      : null;

    const finishOnce = async (): Promise<void> => {
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

      // Item 9 (simplify pass): computed here, after the writableFinished
      // guard above, so an aborted request never pays for it.
      const ipHash = ipHashOf(req);

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

      try {
        if (sessionPromise) await sessionPromise;

        // Public mounts (resolveActor:false) gate subject resolution to
        // 2xx — the finish handler fires on 429s too, and an ungated
        // lookup would hand a distributed brute force one DB read per
        // throttled attempt.
        const subjectUserId =
          resolve.resolveActor || res.statusCode < 300 ? await resolve.subjectFrom(req, actorId) : null;

        await recordAccountAuditEvent(
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
          { onError: onAccountAuditError }
        );
      } catch (error) {
        onAccountAuditError(error);
      }
    };
    // finishOnce is async (item 8: it awaits sessionPromise/subjectFrom); .on()
    // types its listener as returning void, so wrap with `void` at the call
    // site rather than typing finishOnce itself as non-async.
    res.on('finish', () => void finishOnce());
    res.on('close', () => void finishOnce());

    next();
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
    // Item 6 (simplify pass): ONE ADMIN_ACTIONS.get per request, not three
    // independent lookups. A miss returns null — M2's skip-before-any-work
    // gate — so an unknown path can never mint an action string from
    // attacker-controlled path text (HIGH 1's other half of the fix).
    classify: (req) => {
      const known = ADMIN_ACTIONS.get(canonicalPath(req));
      return known ? { action: known.action, includeGet: known.includeGet === true } : null;
    },
    resolveActor: true,
    subjectFrom: (req) => Promise.resolve(extractBodyUserId(req)),
  });
}

/** One exact `FlatMount` — the mount and its subject-resolution strategy. */
function flatMountAuditMiddleware(mount: FlatMount) {
  return auditMiddleware({
    classify: () => ({ action: mount.action, includeGet: false }), // every FlatMount is a POST-only mutation; a stray GET 404s unlogged.
    resolveActor: mount.resolveActor,
    subjectFrom: subjectFromStrategy(mount),
  });
}

/**
 * Item 7 (simplify pass, code review BS#2537 PR #2545 follow-up): collapses
 * what used to be one `app.use('/auth${mount.path}', ...)` layer per
 * `FlatMount` (~20 Express layers total) into ONE layer per partition,
 * dispatching through a prebuilt path -> middleware Map. Built once at
 * module load, not per request.
 */
function buildDispatchMap(
  mounts: readonly FlatMount[]
): ReadonlyMap<string, ReturnType<typeof flatMountAuditMiddleware>> {
  return new Map(mounts.map((mount) => [mount.path, flatMountAuditMiddleware(mount)] as const));
}

const PUBLIC_FLAT_MOUNTS = buildDispatchMap(FLAT_MOUNTS.filter((m) => !m.resolveActor));
const AUTHENTICATED_FLAT_MOUNTS = buildDispatchMap(FLAT_MOUNTS.filter((m) => m.resolveActor));

function dispatchFlatMount(mounts: ReadonlyMap<string, ReturnType<typeof flatMountAuditMiddleware>>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Express 5 strips '/auth' under app.use('/auth', middleware), so
    // req.path here is e.g. '/reset-password' — exactly a FlatMount.path.
    // NOTED BEHAVIOR CHANGE (code review BS#2537 PR #2545, accepted): this
    // is an EXACT match, unlike the old per-mount app.use, which
    // prefix-matched sub-paths (e.g. /delete-user/callback under the
    // /delete-user mount) — that old prefix behavior contradicted the
    // allowlist's own declaration of /delete-user/callback as dead/unaudited,
    // and every such sub-path is GET-only in the real API, so it was never
    // actually LOGGED under the old behavior either (flat mounts never
    // include GET) — only reached and immediately skipped. No recorded row
    // changes; see the PR body.
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    const mw = mounts.get(path);
    if (!mw) return next();
    mw(req, res, next);
  };
}

/** Registers ONE `/auth` layer dispatching the PUBLIC (resolveActor:false) half of FLAT_MOUNTS. Mount this ahead of the Express rate limiters (decision 11) — position is load-bearing, see app.ts. */
export function mountPublicAccountAudit(app: Express): void {
  app.use('/auth', dispatchFlatMount(PUBLIC_FLAT_MOUNTS));
}

/** Registers ONE `/auth` layer dispatching the AUTHENTICATED (resolveActor:true) half of FLAT_MOUNTS. Mount this after the Express rate limiters, ahead of the better-auth catch-all — position is load-bearing, see app.ts. */
export function mountAuthenticatedAccountAudit(app: Express): void {
  app.use('/auth', dispatchFlatMount(AUTHENTICATED_FLAT_MOUNTS));
}
