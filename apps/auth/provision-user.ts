/**
 * Atomic user provisioning: creates user, credential account, and org membership
 * in a single server-side operation. Used by the /auth/admin/provision-user
 * endpoint and by createDefaultUser() at startup.
 */

import { auth, WXYCRoles } from '@wxyc/authentication';
import { db, user } from '@wxyc/database';
import { eq } from 'drizzle-orm';

/** Error with an HTTP status code for the provision-user endpoint. */
export class ProvisionError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

export interface ProvisionUserInput {
  email: string;
  username: string;
  password: string;
  name: string;
  organizationSlug: string;
  role: string;
  realName?: string;
  djName?: string;
}

export interface ProvisionUserResult {
  user: { id: string; email: string; [key: string]: unknown };
  member: { id: string; organizationId: string; role: string; [key: string]: unknown };
}

const ADMIN_SYNC_ROLES = ['stationManager', 'admin', 'owner'];

/**
 * Create a user, credential account, and organization membership atomically.
 *
 * If any step after user creation fails, the created user is deleted to avoid
 * orphaned records. The org must already exist (identified by slug).
 *
 * Replicates the `afterAddMember` hook from auth.definition.ts for admin role
 * sync, since bypassing better-auth's endpoint handler skips plugin hooks.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult> {
  const { email, username, password, name, organizationSlug, role, realName, djName } = input;

  // 1. Validate role
  if (!(role in WXYCRoles)) {
    throw new ProvisionError(400, `Invalid role: "${role}". Must be one of: ${Object.keys(WXYCRoles).join(', ')}`);
  }

  // 2. Get auth context
  const context = await auth.$context;
  const { internalAdapter, adapter } = context;

  // 3. Check for existing user
  const existing = await internalAdapter.findUserByEmail(email);
  if (existing) {
    throw new ProvisionError(409, `User with email "${email}" already exists`);
  }

  // 4. Find organization by slug
  const org = await adapter.findOne<{ id: string }>({
    model: 'organization',
    where: [{ field: 'slug', value: organizationSlug }],
  });
  if (!org) {
    throw new ProvisionError(404, `Organization not found for slug: "${organizationSlug}"`);
  }

  // 5. Create user (catch unique constraint violations on username)
  let newUser;
  try {
    newUser = await internalAdapter.createUser({
      email,
      emailVerified: true,
      name,
      username,
      realName: realName || undefined,
      djName: djName || undefined,
      appSkin: 'modern-light',
      hasCompletedOnboarding: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
      throw new ProvisionError(409, `Username "${username}" is already taken`);
    }
    throw error;
  }

  // 6-9. Remaining steps wrapped for cleanup on failure
  try {
    // 7. Link credential account
    const hashedPassword = await context.password.hash(password);
    await internalAdapter.linkAccount({
      accountId: newUser.id,
      providerId: 'credential',
      password: hashedPassword,
      userId: newUser.id,
    });

    // 8. Create organization membership
    const createdMember = (await adapter.create({
      model: 'member',
      data: {
        userId: newUser.id,
        organizationId: org.id,
        role,
        createdAt: new Date(),
      },
    })) as { id: string; organizationId: string; role: string; [key: string]: unknown };

    // 9. Sync admin role for stationManager (replicates afterAddMember hook)
    if (ADMIN_SYNC_ROLES.includes(role)) {
      await db.update(user).set({ role: 'admin' }).where(eq(user.id, newUser.id));
    }

    // 10. Trigger password reset flow to send welcome email with a tokenized setup URL.
    // The sendResetPassword hook in auth.definition.ts detects hasCompletedOnboarding === false
    // and sends the accountSetup email template instead of a plain password reset.
    const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';
    auth.api
      .requestPasswordReset({
        body: { email, redirectTo: `${frontendUrl}/login` },
        headers: new Headers({ origin: frontendUrl }),
      })
      .catch((error: unknown) => {
        console.error('[PROVISION USER] Failed to trigger setup email:', error);
      });

    return { user: newUser, member: createdMember };
  } catch (error) {
    // Clean up: delete the orphaned user so we don't leave partial state
    try {
      await internalAdapter.deleteUser(newUser.id);
    } catch (cleanupError) {
      console.error('[PROVISION USER] Failed to clean up user after error:', cleanupError);
    }
    throw error;
  }
}
