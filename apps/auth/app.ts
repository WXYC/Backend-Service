// Auth service using Express.
// `instrument.ts` is loaded via `node --import` (see package.json `start`
// script), not statically imported here, so Sentry's auto-instrumentation
// runs before `express` is loaded into the module graph.
import * as Sentry from '@sentry/node';
import { config } from 'dotenv';
config();

import { auth, bootstrapTrustedClients, buildTrustedClients, resolveCorsOrigin } from '@wxyc/authentication';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { rateLimitKeyFromRequest } from './rate-limit-key';
import { closeDatabaseConnection } from '@wxyc/database';
import type { HealthCheckResponse } from '@wxyc/shared/dtos';
import { checkRequestBanHandler } from './check-request-ban-handler';
import { CompleteOnboardingError, completeOnboardingFromRequest } from './complete-onboarding';
import { fallbackErrorHandler } from './fallback-error-handler';
import { lookupEmailByIdentifier } from './lookup-email';
import { provisionUser, ProvisionError } from './provision-user';
import { createAutoDjUser } from './create-auto-dj-user';
import { resolveOrganization } from './resolve-organization';
import { shouldCaptureAuthExpressError } from './sentry-error-filter';
import { E2E_INCOMPLETE_USER_ID, E2E_INCOMPLETE_USER_PASSWORD } from './e2e-test-constants';

const port = process.env.AUTH_PORT || '8082';

const app = express();

// Trust the reverse proxy so `req.ip` resolves from `X-Forwarded-For` for
// non-rate-limit consumers (Sentry's request integration, request logging).
// The Express rate limiter does NOT read `req.ip` — it uses an explicit
// `keyGenerator` keyed on the nginx-set `X-Real-IP`, so XFF spoofing
// cannot influence rate-limit bucketing (see ./rate-limit-key.ts and
// BS#1048). Mirrors the same line in apps/backend/app.ts.
app.set('trust proxy', true);

// Parse JSON bodies first (needed for auth endpoints)
app.use(express.json());

// Apply CORS globally to all routes (must be before auth handler).
// Fail closed when neither FRONTEND_SOURCE nor BETTER_AUTH_TRUSTED_ORIGINS is
// set (BS#1107): the old `|| '*'` fallback combined with `credentials: true`
// reflected any request origin with Access-Control-Allow-Credentials, exposing
// every cookie-authenticated better-auth route (including /auth/admin/*) to
// credentialed calls from arbitrary web origins. `resolveCorsOrigin` returns
// `false` (cors middleware disabled, no CORS headers served) and logs at
// error level instead. BETTER_AUTH_TRUSTED_ORIGINS is consulted second so a
// deploy that configures better-auth's trusted origins but not
// FRONTEND_SOURCE keeps serving its login flow.
app.use(
  cors({
    origin: resolveCorsOrigin(process.env, ['FRONTEND_SOURCE', 'BETTER_AUTH_TRUSTED_ORIGINS']),
    credentials: true,
    // X-Device-Fingerprint is sent on /auth/check-request-ban (BS#1261).
    // Add here so a future browser-origin caller (dj-site admin tool, iOS
    // WebView, etc.) isn't blocked by the preflight.
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Set-Cookie', 'X-Device-Fingerprint'],
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
    exposedHeaders: ['Content-Length', 'Set-Cookie'],
  })
);

// Test helper endpoints (must be registered BEFORE Better Auth handler).
// Positive-list gate (BS#1097): enable only in explicit dev/test. A negative
// check (`!== 'production'`) exposed these to staging or any host where
// NODE_ENV happened to be unset.
if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
  // Get verification token for testing password reset flow
  // Better Auth stores password reset tokens with:
  //   identifier: "reset-password:<token>" or "email-verification:<token>"
  //   value: userId
  // This endpoint accepts an email, looks up the user, then finds their reset token
  app.get('/auth/test/verification-token', async (req, res) => {
    try {
      const identifier = typeof req.query.identifier === 'string' ? req.query.identifier : '';
      const type = typeof req.query.type === 'string' ? req.query.type : 'reset-password';
      if (!identifier) {
        return res.status(400).json({ error: 'identifier query parameter is required (email address)' });
      }

      const { db, verification, user } = await import('@wxyc/database');
      const { eq, desc, like, and } = await import('drizzle-orm');

      // First, look up the user by email to get their userId
      const userResult = await db.select({ id: user.id }).from(user).where(eq(user.email, identifier)).limit(1);

      if (userResult.length === 0) {
        return res.status(404).json({ error: 'User not found with this email' });
      }

      const userId = userResult[0].id;
      const tokenPrefix = `${type}:`;
      const result = await db
        .select()
        .from(verification)
        .where(and(eq(verification.value, userId), like(verification.identifier, `${tokenPrefix}%`)))
        .orderBy(desc(verification.createdAt))
        .limit(1);

      if (result.length === 0) {
        return res.status(404).json({ error: `No ${type} token found for this user` });
      }

      // Extract the actual token from the identifier (e.g., "reset-password:abc123" -> "abc123")
      const fullIdentifier = result[0].identifier;
      const token = fullIdentifier.startsWith(tokenPrefix) ? fullIdentifier.slice(tokenPrefix.length) : fullIdentifier;

      res.json({
        token,
        expiresAt: result[0].expiresAt,
        createdAt: result[0].createdAt,
      });
    } catch (error) {
      console.error('Error fetching verification token:', error);
      res.status(500).json({ error: 'Failed to fetch verification token' });
    }
  });

  // Expire a user's session for testing session timeout
  app.post('/auth/test/expire-session', async (req, res) => {
    try {
      const { userId } = req.body as { userId?: string };
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required in request body' });
      }

      const { db, session } = await import('@wxyc/database');
      const { eq } = await import('drizzle-orm');

      await db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.userId, userId));

      res.json({ success: true, message: `Session expired for user ${userId}` });
    } catch (error) {
      console.error('Error expiring session:', error);
      res.status(500).json({ error: 'Failed to expire session' });
    }
  });

  // Confirm a user (mark onboarding as complete) for testing
  app.post('/auth/test/confirm-user', async (req, res) => {
    try {
      const { userId } = req.body as { userId?: string };
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const { db, user } = await import('@wxyc/database');
      const { eq } = await import('drizzle-orm');

      await db.update(user).set({ hasCompletedOnboarding: true }).where(eq(user.id, userId));

      return res.json({ success: true });
    } catch (error) {
      console.error('[TEST ENDPOINTS] Failed to confirm user:', error);
      return res.status(500).json({ error: 'Failed to confirm user' });
    }
  });

  // Reset the seeded test_incomplete user for session-onboarding E2E
  app.post('/auth/test/reset-incomplete-user', async (req, res) => {
    try {
      const userId =
        typeof (req.body as { userId?: string })?.userId === 'string'
          ? (req.body as { userId: string }).userId
          : E2E_INCOMPLETE_USER_ID;

      const context = await auth.$context;
      const passwordHash = await context.password.hash(E2E_INCOMPLETE_USER_PASSWORD);

      const { db, user, account, session } = await import('@wxyc/database');
      const { eq } = await import('drizzle-orm');

      await db
        .update(user)
        .set({
          hasCompletedOnboarding: false,
          realName: '',
          djName: '',
          updatedAt: new Date(),
        })
        .where(eq(user.id, userId));

      await db.update(account).set({ password: passwordHash }).where(eq(account.userId, userId));

      await db.delete(session).where(eq(session.userId, userId));

      return res.json({ success: true, userId });
    } catch (error) {
      console.error('[TEST ENDPOINTS] Failed to reset incomplete user:', error);
      return res.status(500).json({ error: 'Failed to reset incomplete user' });
    }
  });

  // Report session
  console.log(
    '[TEST ENDPOINTS] Test helper endpoints enabled (/auth/test/verification-token, /auth/test/expire-session, /auth/test/confirm-user, /auth/test/reset-incomplete-user)'
  );
}

// Resolve an organization slug to its UUID.
// Used by dj-site admin pages to avoid the fragile getFullOrganization SDK call.
app.get('/auth/admin/resolve-organization', async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admin role required' });
    }

    const slug = req.query.slug;
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'Missing required query parameter: slug' });
    }

    const org = await resolveOrganization(slug);
    if (!org) {
      return res.status(404).json({ error: `Organization not found for slug: "${slug}"` });
    }

    return res.json(org);
  } catch (error) {
    console.error('[RESOLVE ORG] Unexpected error:', error);
    Sentry.captureException(error, { tags: { subsystem: 'resolve-organization' } });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Provision a new user atomically: create user + credential + org membership.
// Registered before the better-auth handler so it intercepts the request.
app.post('/auth/admin/provision-user', async (req, res) => {
  try {
    // Validate admin session
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admin role required' });
    }

    // Validate required fields
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { email, username, name, organizationSlug, role, realName, djName } = body;
    const missing = ['email', 'username', 'name', 'organizationSlug', 'role'].filter(
      (field) => !body[field] || typeof body[field] !== 'string'
    );
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    if ('password' in body) {
      return res
        .status(400)
        .json({ error: 'password must not be supplied; users set their password via the invite onboarding flow' });
    }

    const result = await provisionUser({
      email: email as string,
      username: username as string,
      name: name as string,
      organizationSlug: organizationSlug as string,
      role: role as string,
      realName: realName as string | undefined,
      djName: djName as string | undefined,
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('[PROVISION USER] Unexpected error:', error);
    Sentry.captureException(error, { tags: { subsystem: 'provision-user' } });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Resolve a login identifier (username or email) to a verification email.
// Public — rate-limited below alongside the other brute-force-sensitive
// endpoints. The login UI accepts a single "Username or email" field and
// calls this only when the identifier contains no '@'. Returning the email
// for a known username is a mild enumeration vector that matches the
// existing leak surface of /auth/sign-in/username (which already reveals
// "user exists" via its error responses). Rate limiting bounds it.
const lookupEmailHandler = async (req: Request, res: Response) => {
  try {
    const identifier = (req.body as { identifier?: unknown })?.identifier;
    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ error: 'identifier required' });
    }

    const email = await lookupEmailByIdentifier(identifier);
    return res.json({ email });
  } catch (error) {
    console.error('[LOOKUP EMAIL] Unexpected error:', error);
    Sentry.captureException(error, { tags: { subsystem: 'lookup-email' } });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const completeOnboardingHandler = async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await completeOnboardingFromRequest(body, fromNodeHeaders(req.headers));
    return res.json(result);
  } catch (error) {
    if (error instanceof CompleteOnboardingError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    console.error('[COMPLETE ONBOARDING] Unexpected error:', error);
    Sentry.captureException(error, { tags: { subsystem: 'complete-onboarding' } });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Disable rate limiting in test environments to avoid flaky integration tests.
// This matches the pattern used by the backend's rateLimiting middleware.
// Positive-list gate (BS#1097): the AUTH_BYPASS / USE_MOCK_SERVICES escape
// hatches are honored only when NODE_ENV is explicitly development or test.
// In any other environment (production, staging, or unset) rate limits hold.
const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  (isDevOrTest && (process.env.USE_MOCK_SERVICES === 'true' || process.env.AUTH_BYPASS === 'true'));

if (!isTestEnv) {
  // Strict limit for auth mutations vulnerable to brute-force attacks.
  // These are the only endpoints that need tight rate limiting.
  const authMutationRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    keyGenerator: rateLimitKeyFromRequest,
  });

  const rateLimitedPaths = [
    '/auth/sign-in',
    '/auth/sign-up',
    '/auth/email-otp/send-verification-otp',
    '/auth/forget-password',
    '/auth/wxyc/lookup-email',
    '/auth/wxyc/complete-onboarding',
    // ADR 0008 — QR device-authorization. Including /code (anonymous,
    // brute-force on the 8-char user_code namespace), /approve (authenticated
    // state-changing), and /deny (authenticated; bounds noise from a stuck
    // client). NOT including /auth/device/token — the plugin enforces
    // pollingInterval server-side via lastPolledAt and returns a structured
    // `slow_down` JSON body when polling is too fast; an HTTP 429 in front
    // would shadow it and break every polling client.
    //
    // Also NOT including `GET /auth/device` (the claim step). Cannot use
    // the plain string form: express `app.use(path, mw)` is a *prefix*
    // match, so `/auth/device` would swallow `/auth/device/token` and
    // shadow `slow_down` in a 429. In practice the 8-char user_code space
    // is ~1.1e12 over a 5-min TTL — brute-forcing a live pending code is
    // impractical — so we accept this as defense-in-depth. If future data
    // shows real oracle abuse, wire in a method+exact-path limiter
    // (`app.use((req, next) => req.method === 'GET' && req.path === '/auth/device' ? limit : next)`).
    '/auth/device/code',
    '/auth/device/approve',
    '/auth/device/deny',
  ];

  for (const path of rateLimitedPaths) {
    app.use(path, authMutationRateLimit);
  }

  // BS#1261 — separate, more generous limiter for /auth/check-request-ban.
  // The brute-force-sensitive limiter above (10/15min) is too tight for the
  // per-request-line traffic profile, but the endpoint is public + does JWT
  // signature verification + 1-2 DB lookups per call, so leaving it
  // unbounded exposes the auth-service DB pool to a cheap DoS.
  const checkRequestBanRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 120, // 2/s sustained per IP, well above expected ROM volume
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    keyGenerator: rateLimitKeyFromRequest,
  });
  app.use('/auth/check-request-ban', checkRequestBanRateLimit);
}

app.post('/auth/wxyc/lookup-email', lookupEmailHandler);
app.post('/auth/wxyc/complete-onboarding', completeOnboardingHandler);

// BS#1261 — request-line ban enforcement. Registered before the better-auth
// handler so this specific path doesn't fall through to better-auth's
// catch-all. ROM calls this on every POST /request to decide allow/block.
// The endpoint is intentionally public (no X-Internal-Key gate): callers
// authenticate per-request via JWT and/or X-Device-Fingerprint, and the
// response shape is driven by those. Per-IP rate limiting is applied
// above to bound the JWT-verify + DB lookup cost.
app.post('/auth/check-request-ban', checkRequestBanHandler);

app.use('/auth', toNodeHandler(auth));

// Liveness/readiness endpoint. Body conforms to HealthCheckResponse from
// @wxyc/shared (api.yaml v1.3.0 / @wxyc/shared v0.13.0); the shape is the
// cross-language contract owned by wxyc-fastapi and adopted here so every
// WXYC service exposes the same status enum + per-dependency `services`
// map. Status codes are preserved verbatim — the upstream /auth/ok status
// is forwarded on the proxy-reachable branch and the catch branch keeps
// 500 — only the body shape changes. wxyc-canary checks `r.ok` only, so
// the body change is non-breaking for the alarm. See
// WXYC/Backend-Service#804.
app.get('/healthcheck', async (req, res) => {
  const authServiceUrl = `http://localhost:${port}`; // Use the port the server is listening on
  try {
    // Make an internal HTTP request to the better-auth /ok endpoint.
    // X-Real-IP is set to 127.0.0.1 because the loopback fetch has no real
    // client. Without it, better-auth's getIp returns null and latches a
    // one-shot "Rate limiting skipped: could not determine client IP"
    // warning, which silently disables its internal rate limiter for the
    // rest of the process lifetime. We pass X-Real-IP rather than XFF
    // because `auth.definition.ts` configures `ipAddressHeaders: ['x-real-ip']`
    // to ignore client-controlled XFF spoofing. See #765 (latch fix) and
    // #774 (XFF -> X-Real-IP swap).
    const response = await fetch(`${authServiceUrl}/auth/ok`, {
      headers: { 'X-Real-IP': '127.0.0.1' },
    });

    // Forward the upstream status verbatim. Drain the body so the socket is
    // freed but discard the legacy `{ ok: true }` payload — the response
    // shape is the shared HealthCheckResponse, derived purely from
    // response.ok rather than the upstream body.
    await response.text().catch(() => undefined);
    const body: HealthCheckResponse = response.ok
      ? { status: 'healthy', services: { auth: 'ok' } }
      : { status: 'unhealthy', services: { auth: 'unavailable' } };
    res.status(response.status).json(body);
  } catch (error) {
    console.error('Error proxying /healthcheck to /auth/ok:', error);
    // If the internal call fails, it indicates a problem with the auth service itself
    const body: HealthCheckResponse = { status: 'unhealthy', services: { auth: 'unavailable' } };
    res.status(500).json(body);
  }
});

// Pass an explicit predicate (BS#1387). Without it, the SDK's default
// `shouldHandleError` falls back to a "treat unknown status as 500" rule that
// captures errors without an explicit status (bare TypeErrors, deserialisation
// faults) indistinguishably from genuine 5xx faults. The named predicate
// documents intent. (It deliberately does NOT mirror the backend's
// `shouldCaptureExpressError`, which suppresses only the trusted 4xx band its
// errorHandler echoes — see the predicate's JSDoc for the divergence.)
Sentry.setupExpressErrorHandler(app, { shouldHandleError: shouldCaptureAuthExpressError });

// Fallback error handler — sanitises response body, forwards full error to
// Sentry. See `./fallback-error-handler.ts` for rationale (BS#1109).
app.use(fallbackErrorHandler);

// Create default user if needed
const createDefaultUser = async () => {
  if (process.env.CREATE_DEFAULT_USER !== 'TRUE') return;

  try {
    const email = process.env.DEFAULT_USER_EMAIL;
    const username = process.env.DEFAULT_USER_USERNAME;
    const password = process.env.DEFAULT_USER_PASSWORD;
    const djName = process.env.DEFAULT_USER_DJ_NAME;
    const realName = process.env.DEFAULT_USER_REAL_NAME;

    const organizationSlug = process.env.DEFAULT_ORG_SLUG;
    const organizationName = process.env.DEFAULT_ORG_NAME;

    if (!username || !email || !password || !djName || !realName || !organizationSlug || !organizationName) {
      throw new Error('Default user credentials are not fully set in environment variables.');
    }

    const context = await auth.$context;
    const internalAdapter = context.internalAdapter;

    const existingUser = await internalAdapter.findUserByEmail(email);

    if (existingUser) {
      console.log('Default user already exists, skipping creation.');
      return;
    }

    // Ensure the organization exists (bootstrap: create if missing)
    const existingOrganization = await context.adapter.findOne<{ id: string }>({
      model: 'organization',
      where: [{ field: 'slug', value: organizationSlug }],
    });

    if (!existingOrganization) {
      await context.adapter.create({
        model: 'organization',
        data: {
          name: organizationName,
          slug: organizationSlug,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }

    // Provision user + credential + membership atomically
    await provisionUser({
      email,
      username,
      password,
      name: username,
      realName,
      djName,
      organizationSlug,
      role: 'stationManager',
    });

    console.log('Default user created successfully with admin role.');
  } catch (error) {
    console.error('[DEFAULT USER] Error creating default user:', error);
    Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'default-user' } });
  }
};

// Fix admin roles for existing stationManagers (one-time migration)
const syncAdminRoles = async () => {
  try {
    const { db, user, member, organization } = await import('@wxyc/database');
    const { eq, sql } = await import('drizzle-orm');

    const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
    if (!defaultOrgSlug) {
      console.log('[ADMIN PERMISSIONS] DEFAULT_ORG_SLUG not set, skipping admin role fix');
      return;
    }

    // Find all users who are stationManager/admin/owner in default org but don't have admin role
    const usersNeedingFix = await db
      .select({
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        memberRole: member.role,
      })
      .from(user)
      .innerJoin(member, sql`${member.userId} = ${user.id}`)
      .innerJoin(organization, sql`${member.organizationId} = ${organization.id}`)
      .where(
        sql`${organization.slug} = ${defaultOrgSlug}
        AND ${member.role} IN ('admin', 'owner', 'stationManager')
        AND (${user.role} IS NULL OR ${user.role} != 'admin')`
      );

    if (usersNeedingFix.length > 0) {
      console.log(`[ADMIN PERMISSIONS] Found ${usersNeedingFix.length} users needing admin role fix: `);
      for (const u of usersNeedingFix) {
        console.log(`[ADMIN PERMISSIONS] - ${u.userEmail} (${u.memberRole}) - current role: ${u.userRole || 'null'}`);
        await db.update(user).set({ role: 'admin' }).where(eq(user.id, u.userId));
        console.log(`[ADMIN PERMISSIONS] - Fixed: ${u.userEmail} now has admin role`);
      }
    } else {
      console.log('[ADMIN PERMISSIONS] All stationManagers already have admin role');
    }
  } catch (error) {
    console.error('[ADMIN PERMISSIONS] Error fixing admin roles:', error);
    Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'admin-sync' } });
  }
};

// Initialize default user and sync admin roles before starting the server
void (async () => {
  await createDefaultUser();
  // Runs after createDefaultUser so the default org already exists. Gated by
  // CREATE_AUTO_DJ_USER (default off); idempotent skip-if-exists. See #1644.
  await createAutoDjUser();
  await syncAdminRoles();

  // Bootstrap oauthApplication rows for every trustedClient. See
  // `bootstrap-trusted-clients.ts` for why this exists. warn-and-continue to
  // match sibling `createDefaultUser` / `syncAdminRoles` posture — a transient
  // DB blip shouldn't take sign-in / session / provision-user down for a bug
  // that only affects OIDC token exchange for two clients. If bootstrap fails,
  // OIDC login 500s at first attempt (loud), everything else keeps working.
  const trustedClients = buildTrustedClients(process.env);
  if (trustedClients.length === 0) {
    console.log(
      '[OIDC BOOTSTRAP] no trustedClients configured — skipping (check *_OIDC_CLIENT_ID env vars if unexpected)'
    );
  } else {
    try {
      // Split the try so an `auth.$context` failure (plugin init, DB pool
      // warm-up race) doesn't mis-tag as an oidc-bootstrap failure — a
      // $context failure would break login/session/provision-user too, so
      // on-call needs the right root-cause tag.
      const context = await auth.$context;
      try {
        const { created, updated } = await bootstrapTrustedClients(context.adapter, trustedClients);
        console.log(
          `[OIDC BOOTSTRAP] trustedClients synced (${created} created, ${updated} updated of ${trustedClients.length})`
        );
      } catch (error) {
        console.error(
          '[OIDC BOOTSTRAP] Failed to sync trustedClients — OIDC token exchange will 500 until this is resolved.',
          error
        );
        Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'oidc-bootstrap' } });
      }
    } catch (error) {
      console.error('[AUTH CONTEXT] Failed to resolve auth.$context before bootstrap:', error);
      Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'auth-context' } });
    }
  }

  const server = app.listen(parseInt(port), () => {
    console.log(`listening on port: ${port}! (auth service)`);
  });

  function shutdown(signal: string): void {
    console.log(`[auth-shutdown] Received ${signal}, shutting down...`);
    server.close(() => {
      closeDatabaseConnection()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => server.closeAllConnections(), 5_000).unref();
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

export default app;
