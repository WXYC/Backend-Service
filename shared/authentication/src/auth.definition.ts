import {
  account,
  db,
  invitation,
  jwks,
  member,
  organization,
  session,
  user,
  verification,
} from '@wxyc/database';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import {
  admin,
  jwt,
  organization as organizationPlugin,
  username,
} from 'better-auth/plugins';
import { eq, sql } from 'drizzle-orm';
import { WXYCRoles } from './auth.roles';
import { sendResetPasswordEmail, sendVerificationEmailMessage } from './email';

const buildResetUrl = (url: string, redirectTo?: string) => {
  if (!redirectTo) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.searchParams.set('redirectTo', redirectTo);
    return parsed.toString();
  } catch {
    return url;
  }
};

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: user,
      session: session,
      account: account,
      verification: verification,
      jwks: jwks,
      organization: organization,
      member: member,
      invitation: invitation,
    },
  }),

  // Base URL for the auth service
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:8082/auth',

  // Trusted origins for CORS
  trustedOrigins: (
    process.env.BETTER_AUTH_TRUSTED_ORIGINS ||
    process.env.FRONTEND_SOURCE ||
    'http://localhost:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Email+password only (social omitted), admin-only creation is in UI
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    disableSignUp: true,
    sendResetPassword: async ({ user, url }, request) => {
      const redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL?.trim();
      const resetUrl = buildResetUrl(url, redirectTo);

      void sendResetPasswordEmail({
        to: user.email,
        resetUrl,
      }).catch((error) => {
        console.error('Error sending password reset email:', error);
      });
    },
    onPasswordReset: async ({ user }, request) => {
      console.log(`Password for user ${user.email} has been reset.`);
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }, request) => {
      void sendVerificationEmailMessage({
        to: user.email,
        verificationUrl: url,
      }).catch((error) => {
        console.error('Error sending verification email:', error);
      });
    },
    autoSignInAfterVerification: true,
  },

  // Subdomain-friendly cookie setting (recommended over cross-site cookies)
  advanced: {
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true
    }
  },

  plugins: [
    admin(),
    username(),
    jwt({
      // JWT plugin configuration
      // JWKS endpoint automatically exposed at /api/auth/jwks
      // Custom payload to include organization member role
      jwt: {
        definePayload: async ({ user }) => {
          // Query organization membership to get member role
          if (user?.id) {
            const memberRecord = await db
              .select({ role: member.role })
              .from(member)
              .where(sql`${member.userId} = ${user.id}` as any)
              .limit(1);

            if (memberRecord.length > 0) {
              return {
                ...user,
                role: memberRecord[0].role, // Use organization member role instead of default user role
              };
            }
          }
          // Fallback to default user data if no organization membership found
          return user;
        },
      },
    }),
    organizationPlugin({
      // Configure for single organization model
      allowUserToCreateOrganization: false, // Only admins can create organizations
      organizationLimit: 1, // Users can only be in one organization
      roles: WXYCRoles,
      // Role information is included via custom JWT definePayload function above
      organizationHooks: {
        // Sync global user.role when members are added to default organization
        afterAddMember: async ({
          member,
          user: userData,
          organization: orgData,
        }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn(
                'DEFAULT_ORG_SLUG is not set, skipping admin role sync'
              );
              return;
            }

            // Only update for default organization
            if (orgData.slug !== defaultOrgSlug) {
              return;
            }

            // Check if role should grant admin permissions
            const adminRoles = ['stationManager', 'admin', 'owner'];
            if (adminRoles.includes(member.role)) {
              // Update user.role to "admin" for Better Auth Admin plugin
              const userId = userData.id;
              await db
                .update(user)
                .set({ role: 'admin' })
                .where(eq(user.id, userId));
              console.log(
                `Granted admin role to user ${userId} (${userData.email}) with ${member.role} role in default organization`
              );
            }
          } catch (error) {
            console.error('Error syncing admin role in afterAddMember:', error);
          }
        },

        // Sync global user.role when member roles are updated
        afterUpdateMemberRole: async ({
          member,
          previousRole,
          user: userData,
          organization: orgData,
        }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn(
                'DEFAULT_ORG_SLUG is not set, skipping admin role sync'
              );
              return;
            }

            // Only update for default organization
            if (orgData.slug !== defaultOrgSlug) {
              return;
            }

            const adminRoles = ['stationManager', 'admin', 'owner'];
            const shouldHaveAdmin = adminRoles.includes(member.role);
            const previouslyHadAdmin = adminRoles.includes(previousRole);

            const userId = userData.id;
            if (shouldHaveAdmin && !previouslyHadAdmin) {
              // Promoted to admin role - grant admin
              await db
                .update(user)
                .set({ role: 'admin' })
                .where(eq(user.id, userId));
              console.log(
                `Granted admin role to user ${userId} (${userData.email}) after promotion to ${member.role}`
              );
            } else if (!shouldHaveAdmin && previouslyHadAdmin) {
              // Demoted from admin role - remove admin
              await db
                .update(user)
                .set({ role: null })
                .where(eq(user.id, userId));
              console.log(
                `Removed admin role from user ${userId} (${userData.email}) after demotion from ${previousRole} to ${member.role}`
              );
            }
          } catch (error) {
            console.error(
              'Error syncing admin role in afterUpdateMemberRole:',
              error
            );
          }
        },

        // Sync global user.role when members are removed from default organization
        afterRemoveMember: async ({
          user: userData,
          organization: orgData,
        }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn(
                'DEFAULT_ORG_SLUG is not set, skipping admin role sync'
              );
              return;
            }

            // Only update for default organization
            if (orgData.slug !== defaultOrgSlug) {
              return;
            }

            // Check if user has any other memberships with admin roles
            const otherAdminMemberships = await db
              .select({ role: member.role })
              .from(member)
              .innerJoin(
                organization,
                sql`${member.organizationId} = ${organization.id}` as any
              )
              .where(
                sql`${member.userId} = ${userData.id}
                AND ${organization.slug} = ${defaultOrgSlug}
                AND ${member.role} IN ('admin', 'owner', 'stationManager')` as any
              )
              .limit(1);

            // If no other admin memberships exist, remove admin role
            if (otherAdminMemberships.length === 0) {
              const userId = userData.id;
              await db
                .update(user)
                .set({ role: null })
                .where(eq(user.id, userId));
              console.log(
                `Removed admin role from user ${userId} (${userData.email}) after removal from default organization`
              );
            }
          } catch (error) {
            console.error(
              'Error syncing admin role in afterRemoveMember:',
              error
            );
          }
        },
      },
    }),
  ],

  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/admin/create-user') {
        return;
      }

      const email = ctx.body?.email;
      if (!email || typeof email !== 'string') {
        return;
      }

      const callbackURL =
        process.env.EMAIL_VERIFICATION_REDIRECT_URL?.trim() ||
        process.env.FRONTEND_SOURCE?.trim();

      void auth.api
        .sendVerificationEmail({
          body: {
            email,
            callbackURL,
          },
        })
        .catch((error) => {
          console.error('Error triggering verification email:', error);
        });
    }),
  },

  // Enable username-based login
  username: { enabled: true },

  user: {
    additionalFields: {
      realName: { type: 'string', required: false },
      djName: { type: 'string', required: false },
      appSkin: { type: 'string', required: true, defaultValue: 'modern-light' },
    },
  },
});

export type Auth = typeof auth;
