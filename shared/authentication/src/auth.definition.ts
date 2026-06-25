import * as Sentry from '@sentry/node';
import {
  account,
  db,
  deviceCode,
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
  anonymous,
  bearer,
  deviceAuthorization,
  emailOTP,
  jwt,
  oidcProvider,
  organization as organizationPlugin,
  username,
} from 'better-auth/plugins';
import { generateId } from '@better-auth/core/utils/id';
import { and, eq, sql } from 'drizzle-orm';
import { WXYCRoles } from './auth.roles';
import { applyDeviceApproveRoleGate, applyDeviceTokenSessionTtl } from './device-authorization';
import { sendEmail, sendOTPEmail, sendResetPasswordEmail, sendVerificationEmailMessage } from './email';
import { buildTrustedClients } from './oidc-trusted-clients';
import { buildLoginPage } from './oidc-login-page';
import { rewriteUrlForFrontend } from './url-rewrite';

const buildResetUrl = (url: string, redirectTo?: string) => {
  const rewrittenUrl = rewriteUrlForFrontend(url);

  if (!redirectTo) {
    return rewrittenUrl;
  }

  try {
    const parsed = new URL(rewrittenUrl);
    parsed.searchParams.set('redirectTo', redirectTo);
    return parsed.toString();
  } catch {
    return rewrittenUrl;
  }
};

// Type annotation avoids TS2742: tsup's DTS emitter cannot reference
// better-auth's internal anonymous plugin types (unexported subpath).
// The `as` is safe — all Auth instances share the same runtime API surface.
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
      deviceCode: deviceCode,
    },
  }),

  // better-auth's default session.expiresIn is 7 days and updateAge is 1 day.
  // Combined with the bearer plugin's per-renewal token rotation, the 1-day
  // updateAge cadence surfaced as DJs being silently signed out roughly once
  // a day on iOS (the client kept using the pre-rotation bearer). The iOS
  // app now captures the rotated set-auth-token; pinning expiresIn here makes
  // sessions effectively permanent for daily users (rolling 1-year window on
  // every renewal), and turning cookieCache off keeps every /auth/token call
  // routed through the database so the renewal/rotation actually happens.
  session: {
    expiresIn: 60 * 60 * 24 * 365,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false },
  },

  // Base URL for the auth service
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:8082/auth',

  // Trusted origins for CORS
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.FRONTEND_SOURCE || 'http://localhost:3000')
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

      // Detect if this is a new user setup or actual password reset
      const userWithCustomFields = user as typeof user & {
        hasCompletedOnboarding?: boolean;
      };
      const isNewUserSetup = userWithCustomFields.hasCompletedOnboarding === false;

      const emailType = isNewUserSetup ? 'accountSetup' : 'passwordReset';

      void sendEmail({
        type: emailType,
        to: user.email,
        url: resetUrl,
      }).catch((error) => {
        console.error(`Error sending ${emailType} email:`, error);
      });
    },
    onPasswordReset: async ({ user }, request) => {
      console.log(`Password for user ${user.email} has been reset.`);
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }, request) => {
      const verificationUrl = rewriteUrlForFrontend(url);

      void sendVerificationEmailMessage({
        to: user.email,
        verificationUrl,
      }).catch((error) => {
        console.error('Error sending verification email:', error);
      });
    },
    autoSignInAfterVerification: true,
  },

  // Subdomain-friendly cookie setting (recommended over cross-site cookies)
  advanced: {
    defaultCookieAttributes: {
      sameSite: (process.env.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none') || 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
    // better-auth's getIp reads the first matching header in
    // `ipAddressHeaders` and trusts `value.split(',')[0].trim()` without
    // consulting Express's `trust proxy`. The default (`x-forwarded-for`)
    // is client-controlled — nginx appends to XFF rather than replacing
    // it, so an external caller can spoof `127.0.0.1` into the first slot
    // and share a rate-limit bucket with the auth healthcheck loopback.
    // The production nginx config (api.wxyc.org server block) sets
    // `X-Real-IP $remote_addr` authoritatively for /auth/* and /healthcheck,
    // so reading from `x-real-ip` makes XFF irrelevant for IP determination.
    // See WXYC/Backend-Service#774.
    ipAddress: {
      ipAddressHeaders: ['x-real-ip'],
    },
  },

  plugins: [
    admin(),
    username({ minUsernameLength: 2 }),
    anonymous({
      emailDomainName: 'anonymous.wxyc.org',
    }),
    bearer(),
    jwt({
      // JWT plugin configuration
      // JWKS endpoint automatically exposed at /api/auth/jwks
      // Custom payload to include organization member role and capabilities
      jwt: {
        definePayload: async ({ user }) => {
          const userWithCapabilities = user as typeof user & {
            capabilities?: string[] | null;
          };
          // Query organization membership to get member role
          if (user?.id) {
            try {
              const memberRecord = await db
                .select({ role: member.role })
                .from(member)
                .where(eq(member.userId, user.id))
                .limit(1);

              if (memberRecord.length > 0) {
                return {
                  ...user,
                  role: memberRecord[0].role,
                  capabilities: userWithCapabilities.capabilities ?? [],
                };
              }
            } catch (error) {
              console.error('[JWT] Failed to fetch member role:', error);
            }
          }
          // Fallback: no organization membership or query failed
          return {
            ...user,
            capabilities: userWithCapabilities?.capabilities ?? [],
          };
        },
      },
    }),
    oidcProvider({
      loginPage: buildLoginPage(process.env),
      allowDynamicClientRegistration: false,
      requirePKCE: true,
      trustedClients: buildTrustedClients(process.env),
      getAdditionalUserInfoClaim: async (userRecord) => {
        try {
          const memberRecord = await db
            .select({ role: member.role })
            .from(member)
            .where(eq(member.userId, userRecord.id))
            .limit(1);
          return {
            role: memberRecord[0]?.role ?? 'member',
            capabilities: (userRecord as typeof userRecord & { capabilities?: string[] }).capabilities ?? [],
          };
        } catch {
          return { role: 'member', capabilities: [] };
        }
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
        afterAddMember: async ({ member, user: userData, organization: orgData }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn('DEFAULT_ORG_SLUG is not set, skipping admin role sync');
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
              await db.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
              console.log(
                `Granted admin role to user ${userId} (${userData.email}) with ${member.role} role in default organization`
              );
            }
          } catch (error) {
            console.error('Error syncing admin role in afterAddMember:', error);
          }
        },

        // Sync global user.role when member roles are updated
        afterUpdateMemberRole: async ({ member, previousRole, user: userData, organization: orgData }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn('DEFAULT_ORG_SLUG is not set, skipping admin role sync');
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
              await db.update(user).set({ role: 'admin' }).where(eq(user.id, userId));
              console.log(`Granted admin role to user ${userId} (${userData.email}) after promotion to ${member.role}`);
            } else if (!shouldHaveAdmin && previouslyHadAdmin) {
              // Demoted from admin role - remove admin
              await db.update(user).set({ role: null }).where(eq(user.id, userId));
              console.log(
                `Removed admin role from user ${userId} (${userData.email}) after demotion from ${previousRole} to ${member.role}`
              );
            }
          } catch (error) {
            console.error('Error syncing admin role in afterUpdateMemberRole:', error);
          }
        },

        // Sync global user.role when members are removed from default organization
        afterRemoveMember: async ({ user: userData, organization: orgData }) => {
          try {
            const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
            if (!defaultOrgSlug) {
              console.warn('DEFAULT_ORG_SLUG is not set, skipping admin role sync');
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
              .innerJoin(organization, sql`${member.organizationId} = ${organization.id}`)
              .where(
                sql`${member.userId} = ${userData.id}
                AND ${organization.slug} = ${defaultOrgSlug}
                AND ${member.role} IN ('admin', 'owner', 'stationManager')`
              )
              .limit(1);

            // If no other admin memberships exist, remove admin role
            if (otherAdminMemberships.length === 0) {
              const userId = userData.id;
              await db.update(user).set({ role: null }).where(eq(user.id, userId));
              console.log(
                `Removed admin role from user ${userId} (${userData.email}) after removal from default organization`
              );
            }
          } catch (error) {
            console.error('Error syncing admin role in afterRemoveMember:', error);
          }
        },
      },
    }),
    // ADR 0008 — QR sign-in for the shared control-room computer (RFC 8628).
    // Browser at dj.wxyc.org calls /device/code, polls /device/token, and the
    // DJ approves from the iOS app via /device/approve. The role gate
    // (hooks.before) rejects `member` users with `access_denied`; the
    // session-TTL clamp (hooks.after) overrides the 7-day cookie default to
    // 12h for device-auth sessions only. The verificationUri keeps a
    // universal-link fallback open for later but the iOS app reads the
    // user_code out of the QR payload directly — it does not navigate the
    // URL.
    deviceAuthorization({
      expiresIn: '5min',
      interval: '5s',
      userCodeLength: 8,
      deviceCodeLength: 32,
      verificationUri: 'https://dj.wxyc.org/device-auth',
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        void sendOTPEmail({ to: email, otp, type }).catch((error) => {
          // Pre-2026-05-24 this was console.error only, so SES errors were
          // invisible to Sentry / oncall. The OTP path is the loudest
          // user-visible email; the other three callers in this file still
          // use console.error and can be migrated as a follow-up.
          console.error('Error sending OTP email:', error);
          Sentry.captureException(error, { tags: { subsystem: 'auth-otp', email_type: type } });
        });
      },
      otpLength: 6,
      expiresIn: 300,
      disableSignUp: true,
      allowedAttempts: 5,
      storeOTP: process.env.NODE_ENV === 'production' ? 'hashed' : 'plain',
    }),
  ],

  hooks: {
    // ADR 0008: gate /device/approve so non-DJ users can't approve a QR
    // sign-in. The plugin's own session check 401s anonymous callers; this
    // hook adds the role check on top.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/device/approve') return;
      const sessionUser = ctx.context.session?.user;
      if (!sessionUser?.id) return; // let the plugin's own auth check 401
      await applyDeviceApproveRoleGate(sessionUser.id, async (uid) => {
        const rows = await db.select({ role: member.role }).from(member).where(eq(member.userId, uid)).limit(1);
        return rows[0];
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/admin/create-user') {
        const email = ctx.body?.email;
        if (!email || typeof email !== 'string') {
          return;
        }

        // Auto-verify email for admin-created users (trusted operation)
        try {
          await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
        } catch (error) {
          console.error('Error auto-verifying admin-created user:', error);
        }
        return;
      }

      // ADR 0008: clamp /device/token sessions to DEVICE_SESSION_TTL_MS.
      // The plugin creates the session with the global default; we override
      // its expiry and rewrite expires_in so the browser and DB agree.
      // ctx.context.returned is the raw body object `ctx.json` produced when
      // the dispatcher is invoked with asResponse=false (see
      // node_modules/better-auth/dist/api/dispatch.mjs:225) — mutating
      // expires_in on it propagates to the HTTP response.
      if (ctx.path === '/device/token') {
        const newSession = ctx.context.newSession;
        const token = newSession?.session?.token;
        const body = ctx.context.returned as { expires_in?: number } | undefined;
        // Only on the success path: failed polls (authorization_pending,
        // slow_down, expired_token, access_denied) don't populate newSession.
        if (!token || !body) return;
        try {
          await applyDeviceTokenSessionTtl(token, body, new Date(), async (t, expiresAt) => {
            await db.update(session).set({ expiresAt }).where(eq(session.token, t));
          });
        } catch (error) {
          // Don't fail the response just because the TTL extension hit a
          // transient DB error — the session is still valid, just at the
          // default expiry. Surface to Sentry so we notice the drift.
          console.error('[device-auth] Failed to clamp session TTL:', error);
          Sentry.captureException(error, { tags: { subsystem: 'device-authorization' } });
        }
      }
    }),
  },

  // Auto-add every newly created non-anonymous user to the default
  // organization as a `member`. Acts as a safety net for any code path that
  // creates users without going through `provisionUser` (e.g. better-auth's
  // bare `POST /admin/create-user` admin endpoint). Without this, those
  // users land in `auth_user` with no `auth_member` row, which breaks
  // `organization.listMembers` (FORBIDDEN) for the affected user and any
  // call that tries to promote them. provisionUser still sets the requested
  // role; it now upserts on top of the row this hook auto-creates.
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          const u = createdUser as { id: string; isAnonymous?: boolean | null };
          // Anonymous-plugin users are per-device throwaways, not station members.
          if (u.isAnonymous) return;

          const defaultOrgSlug = process.env.DEFAULT_ORG_SLUG;
          if (!defaultOrgSlug) {
            console.warn(`[user.create.after] DEFAULT_ORG_SLUG not set; skipping auto-membership for ${u.id}`);
            return;
          }

          try {
            const orgRows = await db
              .select({ id: organization.id })
              .from(organization)
              .where(eq(organization.slug, defaultOrgSlug))
              .limit(1);
            if (orgRows.length === 0) {
              console.warn(
                `[user.create.after] No organization with slug "${defaultOrgSlug}"; skipping auto-membership for ${u.id}`
              );
              return;
            }

            const existing = await db
              .select({ id: member.id })
              .from(member)
              .where(and(eq(member.userId, u.id), eq(member.organizationId, orgRows[0].id)))
              .limit(1);
            if (existing.length > 0) return;

            await db.insert(member).values({
              id: generateId(32),
              userId: u.id,
              organizationId: orgRows[0].id,
              role: 'member',
              createdAt: new Date(),
            });
          } catch (error) {
            // Don't fail user creation just because the safety-net insert
            // hit a race or transient error — the operator can backfill
            // with scripts/backfill-missing-org-members.ts.
            console.error('[user.create.after] Failed to auto-add member row:', error);
          }
        },
      },
    },
  },

  // Enable username-based login
  username: { enabled: true },

  user: {
    additionalFields: {
      realName: { type: 'string', required: false },
      djName: { type: 'string', required: false },
      appSkin: { type: 'string', required: true, defaultValue: 'modern-light' },
      isAnonymous: { type: 'boolean', required: false, defaultValue: false },
      hasCompletedOnboarding: { type: 'boolean', required: false, defaultValue: false },
      // Cross-cutting capabilities independent of role hierarchy (e.g., 'editor', 'webmaster')
      capabilities: { type: 'string[]', required: false, defaultValue: [] },
    },
  },
}) as unknown as ReturnType<typeof betterAuth>;
