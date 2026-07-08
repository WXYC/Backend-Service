/**
 * Atomic user provisioning: creates user, credential account, and org membership
 * in a single server-side operation. Used by the /auth/admin/provision-user
 * endpoint and by createDefaultUser() at startup.
 */

import * as Sentry from '@sentry/node';
import { randomBytes } from 'node:crypto';
import { auth, formatUsernameError, validateUsername, WXYCRoles } from '@wxyc/authentication';
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
  /** Internal-only: createDefaultUser supplies an explicit bootstrap password. */
  password?: string;
  name: string;
  organizationSlug: string;
  role: string;
  realName?: string;
  djName?: string;
}

/** Unguessable bootstrap credential — DJs set their real password via invite token onboarding. */
export function generateProvisionBootstrapPassword(): string {
  return randomBytes(32).toString('base64url');
}

export interface ProvisionUserResult {
  user: { id: string; email: string; [key: string]: unknown };
  member: { id: string; organizationId: string; role: string; [key: string]: unknown };
  // Welcome-email pipeline outcome. `emailSent: false` means the user was
  // provisioned successfully but the password-setup email could not be
  // dispatched — caller should surface this so an admin can manually resend.
  emailSent: boolean;
  emailError?: string;
}

const ADMIN_SYNC_ROLES = ['stationManager', 'admin', 'owner'];

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  const { email, username, name, organizationSlug, role, realName, djName } = input;
  const password = input.password ?? generateProvisionBootstrapPassword();

  // 1. Validate role
  if (!(role in WXYCRoles)) {
    throw new ProvisionError(400, `Invalid role: "${role}". Must be one of: ${Object.keys(WXYCRoles).join(', ')}`);
  }

  // 1b. Validate username matches what better-auth's username plugin will accept
  // at sign-in time. Otherwise we'd create accounts that can never log in via
  // /sign-in/username (the validator there rejects the request before the DB
  // is touched). See shared/authentication/src/auth.username.ts.
  const usernameError = validateUsername(username);
  if (usernameError) {
    throw new ProvisionError(400, formatUsernameError(usernameError));
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
    const message = errorMessage(error);
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

    // 8. Ensure organization membership exists with the requested role.
    //    The `databaseHooks.user.create.after` hook in auth.definition.ts
    //    auto-creates a member row with role='member' for every non-anonymous
    //    user, so by the time we get here a row may already exist. Upsert
    //    instead of insert so the caller still gets the role they asked for.
    const existingMember = await adapter.findOne<{ id: string; userId: string; organizationId: string; role: string }>({
      model: 'member',
      where: [
        { field: 'userId', value: newUser.id },
        { field: 'organizationId', value: org.id },
      ],
    });

    let createdMember: { id: string; organizationId: string; role: string; [key: string]: unknown };
    if (existingMember) {
      if (existingMember.role !== role) {
        await adapter.update({
          model: 'member',
          where: [{ field: 'id', value: existingMember.id }],
          update: { role },
        });
      }
      createdMember = { ...existingMember, role };
    } else {
      createdMember = (await adapter.create({
        model: 'member',
        data: {
          userId: newUser.id,
          organizationId: org.id,
          role,
          createdAt: new Date(),
        },
      })) as typeof createdMember;
    }

    // 9. Sync admin role for stationManager (replicates afterAddMember hook)
    if (ADMIN_SYNC_ROLES.includes(role)) {
      await db.update(user).set({ role: 'admin' }).where(eq(user.id, newUser.id));
    }

    // 10. Trigger password reset flow to send welcome email with a tokenized setup URL.
    // The sendResetPassword hook in auth.definition.ts detects hasCompletedOnboarding === false
    // and sends the accountSetup email template instead of a plain password reset.
    //
    // AWAITED (not fire-and-forget) so we can report `emailSent` to the caller.
    // A swallow-style .catch() leaks: the dj-site UI reports success, but the
    // user gets no email and has no way to log in. The provisioning itself
    // succeeded though — user row, credential, and member row are committed —
    // so we don't throw.
    const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';
    let emailSent = true;
    let emailError: string | undefined;
    try {
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: `${frontendUrl}/onboarding` },
        headers: new Headers({ origin: frontendUrl }),
      });
    } catch (error) {
      emailSent = false;
      emailError = errorMessage(error);
      console.error('[PROVISION USER] Failed to trigger setup email:', error);
      Sentry.captureException(error, {
        tags: { subsystem: 'provision-user', step: 'request-password-reset' },
        extra: { email, userId: newUser.id },
      });
    }

    return {
      user: newUser,
      member: createdMember as unknown as ProvisionUserResult['member'],
      emailSent,
      emailError,
    };
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
