// Auth service using Express
import './instrument.js';
import * as Sentry from '@sentry/node';
import { config } from 'dotenv';
config();

import { auth } from '@wxyc/authentication';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { closeDatabaseConnection } from '@wxyc/database';
import { provisionUser, ProvisionError } from './provision-user';
import { resolveOrganization } from './resolve-organization';

const port = process.env.AUTH_PORT || '8082';

const app = express();

// Parse JSON bodies first (needed for auth endpoints)
app.use(express.json());

// Apply CORS globally to all routes (must be before auth handler)
app.use(
  cors({
    origin: process.env.FRONTEND_SOURCE || '*',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Set-Cookie'],
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
    exposedHeaders: ['Content-Length', 'Set-Cookie'],
  })
);

// Test helper endpoints (must be registered BEFORE Better Auth handler)
// Disabled in production
if (process.env.NODE_ENV !== 'production') {
  // Get verification token for testing password reset flow
  // Better Auth stores password reset tokens with:
  //   identifier: "reset-password:<token>" or "email-verification:<token>"
  //   value: userId
  // This endpoint accepts an email, looks up the user, then finds their reset token
  app.get('/auth/test/verification-token', async (req, res) => {
    try {
      const identifier = String(req.query.identifier ?? '');
      const type = String(req.query.type ?? 'reset-password');
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

  // Report session
  console.log(
    '[TEST ENDPOINTS] Test helper endpoints enabled (/auth/test/verification-token, /auth/test/expire-session, /auth/test/confirm-user)'
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

    const org = await resolveOrganization(slug, session);
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
    const { email, username, password, name, organizationSlug, role, realName, djName } = req.body as Record<
      string,
      unknown
    >;
    const missing = ['email', 'username', 'password', 'name', 'organizationSlug', 'role'].filter(
      (f) => !req.body?.[f] || typeof req.body[f] !== 'string'
    );
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const result = await provisionUser({
      email: email as string,
      username: username as string,
      password: password as string,
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

// Disable rate limiting in test environments to avoid flaky integration tests.
// This matches the pattern used by the backend's rateLimiting middleware.
const isTestEnv =
  process.env.NODE_ENV === 'test' || process.env.USE_MOCK_SERVICES === 'true' || process.env.AUTH_BYPASS === 'true';

if (isTestEnv) {
  app.use('/auth', toNodeHandler(auth));
} else {
  // Strict limit for auth mutations vulnerable to brute-force attacks.
  // These are the only endpoints that need tight rate limiting.
  const authMutationRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  const rateLimitedPaths = [
    '/auth/sign-in',
    '/auth/sign-up',
    '/auth/email-otp/send-verification-otp',
    '/auth/forget-password',
  ];

  for (const path of rateLimitedPaths) {
    app.use(path, authMutationRateLimit);
  }

  app.use('/auth', toNodeHandler(auth));
}

//endpoint for healthchecks
app.get('/healthcheck', async (req, res) => {
  const authServiceUrl = `http://localhost:${port}`; // Use the port the server is listening on
  try {
    // Make an internal HTTP request to the better-auth /ok endpoint
    const response = await fetch(`${authServiceUrl}/auth/ok`);

    // Forward the status and body from the /auth/ok response
    const data = (await response.json()) as Record<string, unknown>;
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying /healthcheck to /auth/ok:', error);
    // If the internal call fails, it indicates a problem with the auth service itself
    res.status(500).json({ message: 'Healthcheck failed: Could not reach internal /auth/ok endpoint' });
  }
});

Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
});

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
  await syncAdminRoles();

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
