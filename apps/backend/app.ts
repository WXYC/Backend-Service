import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { parse as parse_yaml } from 'yaml';
import swaggerContent from './app.yaml';
import { dj_route } from './routes/djs.route.js';
import { flowsheet_route } from './routes/flowsheet.route.js';

import { library_route } from './routes/library.route.js';
import { scanner_route } from './routes/scanner.route.js';
import { schedule_route } from './routes/schedule.route.js';
import { events_route } from './routes/events.route.js';
import { request_line_route } from './routes/requestLine.route.js';
import { showMemberMiddleware } from './middleware/checkShowMember.js';
import { activeShow } from './middleware/checkActiveShow.js';
import errorHandler from './middleware/errorHandler.js';
import { auth, requirePermissions } from '@wxyc/authentication';
import { toNodeHandler } from 'better-auth/node';

const port = process.env.PORT || 8080;
const app = express();

//Interpret parse json into js objects
app.use(express.json());

//CORS
app.use(
  cors({
    origin: process.env.FRONTEND_SOURCE || '*',
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Set-Cookie'],
    exposedHeaders: ['Content-Length', 'Set-Cookie'],
    credentials: true,
  })
);

// Test helper endpoints for auth (must be registered BEFORE Better Auth handler)
// Disabled in production
if (process.env.NODE_ENV !== 'production') {
  app.get('/auth/test/verification-token', async (req, res) => {
    try {
      const { identifier, type = 'reset-password' } = req.query;
      if (!identifier || typeof identifier !== 'string') {
        return res.status(400).json({ error: 'identifier query parameter is required (email address)' });
      }

      const { db, verification, user } = await import('@wxyc/database');
      const { eq, desc, like, and } = await import('drizzle-orm');

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

  app.post('/auth/test/expire-session', async (req, res) => {
    try {
      const { userId } = req.body;
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

  console.log(
    '[TEST ENDPOINTS] Test helper endpoints enabled (/auth/test/verification-token, /auth/test/expire-session)'
  );
}

// Mount Better Auth handler for all auth routes.
// better-auth derives its basePath from BETTER_AUTH_URL (e.g. /auth),
// so we mount at the root and let better-auth handle path matching.
// Express 5 strips the mount prefix when using app.use('/auth', ...),
// but toNodeHandler needs the full path, so mount at root.
app.all('/auth/{*path}', toNodeHandler(auth));

// Serve documentation
const swaggerDoc = parse_yaml(swaggerContent);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// Business logic routes
// Scanner route must be registered before the general library route
// because /library/scan is a more specific prefix than /library
app.use('/library/scan', scanner_route);
app.use('/library', library_route);

app.use('/flowsheet', flowsheet_route);

app.use('/djs', dj_route);

app.use('/request', request_line_route);

app.use('/schedule', schedule_route);

app.use(
  '/events',
  (req, res, next) => {
    // no global timeout on these long lived connections
    // SSE logic handles timeouts itself
    res.setTimeout(0);
    next();
  },
  events_route
);

//example for how to use te Cognito auth middleware
app.get('/testAuth', requirePermissions({ flowsheet: ['read'] }), async (req, res) => {
  res.json({ message: 'Authenticated!' });
});

//endpoint for healthchecks
app.get('/healthcheck', async (req, res) => {
  res.json({ message: 'Healthy!' });
});

app.use(errorHandler);

// Create default user if configured
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
    const adapter = context.adapter;
    const internalAdapter = context.internalAdapter;
    const passwordUtility = context.password;

    const existingUser = await internalAdapter.findUserByEmail(email);

    if (existingUser) {
      console.log('Default user already exists, skipping creation.');
      return;
    }

    const newUser = await internalAdapter.createUser({
      email: email,
      emailVerified: true,
      name: username,
      username: username,
      createdAt: new Date(),
      updatedAt: new Date(),
      real_name: realName,
      dj_name: djName,
      app_skin: 'modern-light',
    });

    const hashedPassword = await passwordUtility.hash(password);
    await internalAdapter.linkAccount({
      accountId: crypto.randomUUID(),
      providerId: 'credential',
      password: hashedPassword,
      userId: newUser.id,
    });

    let organizationId;

    const existingOrganization = await adapter.findOne<{ id: string }>({
      model: 'organization',
      where: [{ field: 'slug', value: organizationSlug }],
    });

    if (existingOrganization) {
      organizationId = existingOrganization.id;
    } else {
      const newOrganization = await adapter.create({
        model: 'organization',
        data: {
          name: organizationName,
          slug: organizationSlug,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      organizationId = newOrganization.id;
    }

    if (!organizationId) {
      throw new Error('Failed to create or retrieve organization for default user.');
    }

    const existingMembership = await adapter.findOne<{ id: string }>({
      model: 'member',
      where: [
        { field: 'userId', value: newUser.id },
        { field: 'organizationId', value: organizationId },
      ],
    });

    if (existingMembership) {
      throw new Error('Somehow, default user membership already exists for new user.');
    }

    await adapter.create({
      model: 'member',
      data: {
        userId: newUser.id,
        organizationId: organizationId,
        role: 'stationManager',
        createdAt: new Date(),
      },
    });

    const { db, user } = await import('@wxyc/database');
    const { eq } = await import('drizzle-orm');
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, newUser.id));

    console.log('Default user created successfully with admin role.');
  } catch (error) {
    console.error('Error creating default user!');
    throw error;
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

    const usersNeedingFix = await db
      .select({
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        memberRole: member.role,
      })
      .from(user)
      .innerJoin(member, sql`${member.userId} = ${user.id}` as any)
      .innerJoin(organization, sql`${member.organizationId} = ${organization.id}` as any)
      .where(
        sql`${organization.slug} = ${defaultOrgSlug}
        AND ${member.role} IN ('admin', 'owner', 'stationManager')
        AND (${user.role} IS NULL OR ${user.role} != 'admin')` as any
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
  }
};

// Initialize default user and sync admin roles, then start server
void (async () => {
  await createDefaultUser();
  await syncAdminRoles();

  const server = app.listen(port, () => {
    console.log(`listening on port: ${port}!`);
  });

  server.setTimeout(30000);
})();
