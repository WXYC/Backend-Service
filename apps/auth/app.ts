// Auth service using Express
import { config } from 'dotenv';
const dotenvResult = config();

import { auth } from '@wxyc/authentication';
import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import express from 'express';

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

// Mount the Better Auth handler for all auth routes
// app.use() will handle all methods and paths under /api/auth
app.use('/api/auth', toNodeHandler(auth));

//endpoint for healthchecks
app.get('/healthcheck', async (req, res) => {
  const authServiceUrl = `http://localhost:${port}`; // Use the port the server is listening on
  try {
    // Make an internal HTTP request to the better-auth /ok endpoint
    const response = await fetch(`${authServiceUrl}/api/auth/ok`);

    // Forward the status and body from the /api/auth/ok response
    const data = await response.json(); // Assuming /api/auth/ok returns JSON
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying /healthcheck to /api/auth/ok:', error);
    // If the internal call fails, it indicates a problem with the auth service itself
    res.status(500).json({ message: 'Healthcheck failed: Could not reach internal /api/auth/ok endpoint' });
  }
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
    const adapter = context.adapter;

    const internalAdapter = context.internalAdapter;
    const passwordUtility = context.password;

    const existingUser = await internalAdapter.findUserByEmail(email);

    if (existingUser) {
      console.log('Default user already exists, skipping creation.');
      return;
    }

    const newUser = await internalAdapter.createUser({
      // Required
      email: email,
      emailVerified: true,
      name: username,
      username: username,
      // Optional/Additional fields
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

    console.log('Default user created successfully.');
  } catch (error) {
    console.error('Error creating default user!');
    throw error;
  }
};

// Fix admin roles for existing stationManagers (one-time migration)
const fixExistingAdminRoles = async () => {
  try {
    const { db, user, member, organization } = await import('@wxyc/database');
    const { eq, sql } = await import('drizzle-orm');
    
    const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
    if (!defaultOrgSlug) {
      console.log('[ADMIN FIX] DEFAULT_ORG_SLUG not set, skipping admin role fix');
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
      .innerJoin(member, sql`${member.userId} = ${user.id}` as any)
      .innerJoin(organization, sql`${member.organizationId} = ${organization.id}` as any)
      .where(
        sql`${organization.slug} = ${defaultOrgSlug}
        AND ${member.role} IN ('admin', 'owner', 'stationManager')
        AND (${user.role} IS NULL OR ${user.role} != 'admin')` as any
      );

    if (usersNeedingFix.length > 0) {
      console.log(`[ADMIN FIX] Found ${usersNeedingFix.length} users needing admin role fix:`);
      for (const u of usersNeedingFix) {
        console.log(`[ADMIN FIX] - ${u.userEmail} (${u.memberRole}) - current role: ${u.userRole || 'null'}`);
        await db
          .update(user)
          .set({ role: 'admin' })
          .where(eq(user.id, u.userId));
        console.log(`[ADMIN FIX] - Fixed: ${u.userEmail} now has admin role`);
      }
    } else {
      console.log('[ADMIN FIX] All stationManagers already have admin role');
    }
  } catch (error) {
    console.error('[ADMIN FIX] Error fixing admin roles:', error);
  }
};

// Initialize default user before starting the server
(async () => {
  await createDefaultUser();
  await fixExistingAdminRoles();

  app.listen(parseInt(port), async () => {
    console.log(`listening on port: ${port}! (auth service)`);
  });
})();

export default app;
