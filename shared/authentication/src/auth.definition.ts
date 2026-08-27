import * as Sentry from '@sentry/node';
import {
  account,
  db,
  deviceCode,
  invitation,
  jwks,
  member,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  organization,
  session,
  user,
  verification,
} from '@wxyc/database';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
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
import {
  applyDeviceApproveRoleGate,
  applyDeviceTokenSessionTtl,
  capSessionUpdateAgainstDeviceFlow,
  DEVICE_SESSION_TTL_MS,
} from './device-authorization';
import { sendEmail, sendOTPEmail, sendResetPasswordEmail, sendVerificationEmailMessage } from './email';
import { buildTrustedClients } from './oidc-trusted-clients';
import { buildLoginPage } from './oidc-login-page';
import { buildResetUrl, rewriteUrlForFrontend } from './url-rewrite';
import { accountSetupTokenExpiresInSeconds } from './account-setup-token';
import { buildJwtPayload, buildOidcUserInfoClaim, type MemberRoleRow } from './jwt-payload';
import {
  grantsAdminFlag,
  syncAdminFlagOnAddMember,
  syncAdminFlagOnRemoveMember,
  syncAdminFlagOnUpdateMemberRole,
  type AdminFlagSyncDeps,
} from './admin-flag-sync';

/**
 * The one place a station role is read. Both token-minting paths and the
 * device-approve gate resolve `role` from `auth_member`, never from
 * `auth_user.role` — that column is the better-auth admin plugin's system
 * flag and carries no station role.
 *
 * KNOWN GAP, deliberately not fixed here (BS#2286): this `.limit(1)` has no
 * `ORDER BY` and no default-org filter, so a user holding two memberships
 * mints a non-deterministic station role into their JWT, and a membership in
 * *any* organization can supply it. That is the same multi-membership hazard
 * this change removed from `hasOtherAdminMembership` below — the difference is
 * that fixing it here changes which role real users get in their token, which
 * deserves its own PR and its own review rather than riding along with a
 * refactor that is otherwise behavior-preserving.
 */
const selectMemberRole = async (userId: string): Promise<MemberRoleRow> => {
  const rows = await db.select({ role: member.role }).from(member).where(eq(member.userId, userId)).limit(1);
  return rows[0];
};

/**
 * Does any *other* membership in the default organization still justify the
 * admin flag? Consulted when a member is removed, so a user who holds the
 * role through a second row does not lose it.
 */
const hasOtherAdminMembership = async (userId: string, defaultOrgSlug: string): Promise<boolean> => {
  // The role predicate is applied in TS via `grantsAdminFlag`, not as a SQL
  // IN-list, so grant and revocation accept exactly the same strings — a
  // hardcoded list here would stay narrow while the grant path widened with
  // the shared alias table (BS#2282). Consequently there is NO `.limit(1)`:
  // with the role filter out of SQL, a limit would return one arbitrary
  // membership, and a user holding both a `dj` and a `stationManager` row
  // would wrongly lose the flag on removal. Row counts here are per-user and
  // tiny (organizationLimit: 1).
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(organization, sql`${member.organizationId} = ${organization.id}`)
    .where(
      sql`${member.userId} = ${userId}
                AND ${organization.slug} = ${defaultOrgSlug}`
    );
  return rows.some((row) => typeof row.role === 'string' && grantsAdminFlag(row.role));
};

/**
 * `defaultOrgSlug` is resolved per invocation, matching the hooks' original
 * per-fire `process.env` read.
 */
const adminFlagSyncDeps = (hookName: string): AdminFlagSyncDeps => ({
  defaultOrgSlug: process.env.DEFAULT_ORG_SLUG,
  setUserRole: async (userId, role) => {
    await db.update(user).set({ role }).where(eq(user.id, userId));
  },
  onError: (error) => console.error(`Error syncing admin role in ${hookName}:`, error),
});

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
      oauthApplication: oauthApplication,
      oauthAccessToken: oauthAccessToken,
      oauthConsent: oauthConsent,
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

  // Trusted origins for CORS.
  //
  // `CORS_PREVIEW_ORIGINS` is unioned on rather than being another `||` rung:
  // it must widen the primary list, never replace it, and it must apply
  // whichever of the two primaries won. Wildcard entries (e.g.
  // `https://*.wxyc-dj.pages.dev` for the dj-site Cloudflare Pages preview
  // deployments) pass straight through — better-auth matches each entry with
  // `matchesOriginPattern`, which understands `*`/`?` globs. The Express CORS
  // layer compiles the same wildcards via `resolveCorsOrigin` reading the same
  // variable, so both trust layers agree on exactly which previews are trusted.
  //
  // The previews deliberately do NOT live in `FRONTEND_SOURCE`: that variable
  // is read as a single origin by `oidc-login-page.ts`, `url-rewrite.ts`, and
  // `provision-user.ts`, and a comma-joined value parses there rather than
  // throwing (`new URL('https://a.org,https://b.dev').host` is `a.org,https`).
  trustedOrigins: [
    process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.FRONTEND_SOURCE || 'http://localhost:3000',
    process.env.CORS_PREVIEW_ORIGINS ?? '',
  ]
    .join(',')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Email+password only (social omitted), admin-only creation is in UI
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    disableSignUp: true,
    sendResetPassword: async ({ user, url, token }, request) => {
      const redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL?.trim();
      const resetUrl = buildResetUrl(url, redirectTo);

      // Detect if this is a new user setup or actual password reset
      const userWithCustomFields = user as typeof user & {
        hasCompletedOnboarding?: boolean;
      };
      const isNewUserSetup = userWithCustomFields.hasCompletedOnboarding === false;

      const emailType = isNewUserSetup ? 'accountSetup' : 'passwordReset';

      // Account-setup invites that reach this hook (admin roster "Send Invite"
      // resend, or a forgot-password by a not-yet-onboarded DJ) arrive with
      // better-auth's 1-hour reset token already minted. Extend it to the
      // account-setup TTL so the emailed link matches provisionUser's long-lived
      // invite — DJs act on setup links days later (BS#1969). Genuine password
      // resets (completed users) keep the 1-hour default untouched. Uses `db`
      // directly (like the other hooks in this file) rather than `auth.$context`
      // to avoid referencing `auth` before its initializer completes.
      if (isNewUserSetup) {
        try {
          const extended = await db
            .update(verification)
            .set({ expiresAt: new Date(Date.now() + accountSetupTokenExpiresInSeconds() * 1000) })
            .where(eq(verification.identifier, `reset-password:${token}`))
            .returning({ id: verification.id });
          // better-auth minted this row microseconds ago, so a zero-row match is
          // never expected — it would mean the `reset-password:` identifier
          // contract drifted (e.g. a better-auth upgrade) and the DJ silently got
          // an un-extended 1-hour link, re-opening BS#1969 with no other signal.
          if (extended.length === 0) {
            Sentry.captureException(new Error('Account-setup token expiry extension matched no verification row'), {
              tags: { subsystem: 'account-setup-invite', step: 'extend-token-expiry' },
            });
          }
        } catch (error) {
          console.error('Error extending account-setup token expiry:', error);
          Sentry.captureException(error, {
            tags: { subsystem: 'account-setup-invite', step: 'extend-token-expiry' },
          });
        }
      }

      // Fire-and-forget so the /request-password-reset response isn't held open
      // on the SES round-trip — this hook is awaited by better-auth's
      // runInBackgroundOrAwait, so awaiting the send would block the endpoint on
      // SES latency for every reset. Throttles/bounces still reach Sentry rather
      // than vanishing (BS#1969). Mirrors the emailVerification hook below; the
      // endpoint keeps its generic 200 so a caller can't learn whether the
      // address exists.
      void sendEmail({
        type: emailType,
        to: user.email,
        url: resetUrl,
      }).catch((error) => {
        console.error(`Error sending ${emailType} email:`, error);
        Sentry.captureException(error, {
          tags: { subsystem: 'auth-reset-email', email_type: emailType },
        });
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

  // BS#2169. better-auth keys its internal limiter on `${ip}|${path}`, and
  // 100% of /auth/get-session traffic reaches us from Cloudflare egress IPs
  // (dj-site's SSR arm is an edge-side fetch carrying only a cookie), so the
  // entire DJ population shares ~10 buckets. Worse, the limiter resets on time
  // since the last ALLOWED request, so a continuously-active key accumulates to
  // `max` and 429s regardless of rate. Express owns this path instead, keyed on
  // the session cookie — see apps/auth/rate-limit-key.ts.
  //
  // The key is `/get-session`, not `/auth/get-session`: normalizePathname
  // strips the basePath before matching. `false` short-circuits
  // resolveRateLimitConfig before storage is touched.
  //
  // This block does NOT enable rate limiting or change window/max — those keep
  // their create-context defaults (`enabled: ?? isProduction`, 10s/100).
  rateLimit: {
    customRules: {
      '/get-session': false,
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
        definePayload: async ({ user }) =>
          buildJwtPayload(user, selectMemberRole, (error) =>
            console.error('[JWT] Failed to fetch member role:', error)
          ),
      },
    }),
    oidcProvider({
      loginPage: buildLoginPage(process.env),
      allowDynamicClientRegistration: false,
      requirePKCE: true,
      // #1580 — route id_token signing through the JWT plugin's asymmetric
      // key (RS256 / EdDSA) rather than the default per-client HMAC (HS256).
      // Better-auth's HS256 path signs with `client.clientSecret` as the
      // HMAC key (`node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:649`);
      // for a public client (`type: 'public'`, no `clientSecret`), the call
      // reduces to `sign(new TextEncoder().encode(undefined))` → zero-length
      // key → jose throws `JWSInvalid` → 500 out of the token endpoint. The
      // JWT plugin's asymmetric signer works uniformly for `web` and
      // `public` clients and needs no per-client secret. This flag requires
      // the `jwt()` plugin to be registered ahead of `oidcProvider` — the
      // pin is asserted by `tests/unit/authentication/oidc-provider-public-client-jwt.test.ts`.
      // Do not flip this to `false` without also removing the wxyc-canary
      // public trustedClient (see #1578, wxyc-canary#60).
      useJWTPlugin: true,
      trustedClients: buildTrustedClients(process.env),
      getAdditionalUserInfoClaim: async (userRecord) => buildOidcUserInfoClaim(userRecord, selectMemberRole),
    }),
    organizationPlugin({
      // Configure for single organization model
      allowUserToCreateOrganization: false, // Only admins can create organizations
      organizationLimit: 1, // Users can only be in one organization
      roles: WXYCRoles,
      // Role information is included via custom JWT definePayload function above
      organizationHooks: {
        // Sync global user.role when members are added to default organization
        afterAddMember: async (data) => syncAdminFlagOnAddMember(data, adminFlagSyncDeps('afterAddMember')),

        // Sync global user.role when member roles are updated
        afterUpdateMemberRole: async (data) =>
          syncAdminFlagOnUpdateMemberRole(data, adminFlagSyncDeps('afterUpdateMemberRole')),

        // Sync global user.role when members are removed from default organization
        afterRemoveMember: async (data) =>
          syncAdminFlagOnRemoveMember(data, { ...adminFlagSyncDeps('afterRemoveMember'), hasOtherAdminMembership }),
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
      // Upstream quirk on better-auth ≤ 1.6.20: `schema` was declared
      // `z.custom(() => true)` with no `.optional()` in
      // deviceAuthorizationOptionsSchema, so the runtime zod parse threw
      // when absent while TypeScript's looser `unknown` type hid it. Fixed
      // upstream in 1.6.21 (better-auth#9939); this `{}` becomes droppable
      // once we bump the dependency (dependabot #1510). Passing `{}` stays
      // safe on 1.6.22 — `mergeSchema()` folds in the plugin defaults from
      // node_modules/better-auth/dist/plugins/device-authorization/schema.mjs.
      schema: {},
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
    //
    // ctx.context.session is not pre-populated for /device/approve — the
    // plugin's handler resolves it on its own via getSessionFromCtx (see
    // node_modules/better-auth/dist/plugins/device-authorization/routes.mjs
    // deviceApprove). We do the same here so the role lookup runs against
    // the same session the handler will see. Costs one extra DB round-trip
    // per approve request, fine for the ADR 0008 path.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/device/approve') return;
      const session = await getSessionFromCtx(ctx);
      if (!session?.user?.id) return; // let the plugin's own UNAUTHORIZED fire
      await applyDeviceApproveRoleGate(session.user.id, selectMemberRole, async (uid) => {
        // S1 (#1494 review): reset any *pending* device-code row the
        // rejected user claimed via GET /auth/device?user_code=… so the
        // plugin's `deviceCodeRecord.userId === session.user.id` check
        // stops treating them as the approver. Scoped by (userId + pending)
        // so we don't disturb an in-flight approval elsewhere.
        await db
          .update(deviceCode)
          .set({ userId: null })
          .where(and(eq(deviceCode.userId, uid), eq(deviceCode.status, 'pending')));
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/admin/create-user') {
        // BS#1118: key the auto-verify UPDATE off the just-created user's id,
        // not the request-body email. The admin/create-user endpoint's own
        // handler lowercases ctx.body.email before storing it and only
        // checks for a case-sensitive existing match, so an admin submitting
        // a different case than what ends up on disk (or a pre-existing
        // case-variant row from another write path) previously meant
        // `WHERE email = ctx.body.email` could silently miss the new row,
        // flip an unrelated same-email-different-case row instead, or (in a
        // create race) flip both. ctx.context.returned is the endpoint's
        // `ctx.json({ user })` response body — the same mechanism the
        // /device/token hook below already relies on — so the created id is
        // available here.
        const created = ctx.context.returned as { user?: { id?: string } } | undefined;
        const userId = created?.user?.id;
        if (!userId || typeof userId !== 'string') {
          return;
        }

        // Auto-verify email for admin-created users (trusted operation)
        try {
          await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
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
        if (!newSession || !token || !body) return;

        // The device-authorization plugin's /device/token route creates the
        // session (setNewSession) but never setSessionCookie — it is an OAuth
        // token endpoint that hands the session back as a bearer `access_token`
        // in the body. WXYC's shared-computer QR flow is browser-based (the
        // "device" is the control-room browser), and that browser drives SSR
        // requireAuth off the session *cookie*, not the bearer. Without this the
        // poll 200s but the browser never actually signs in (WXYC/dj-site#841).
        // Emit the cookie here, clamped to the same 12h ceiling as the DB row
        // (ADR 0008) via an explicit maxAge override. Runs before the TTL-clamp
        // DB write so a transient DB error can't leave the browser cookieless.
        await setSessionCookie(ctx, newSession, false, {
          maxAge: DEVICE_SESSION_TTL_MS / 1000,
        });

        try {
          await applyDeviceTokenSessionTtl(token, body, new Date(), async (t, expiresAt, deviceFlowExpiresAt) => {
            await db.update(session).set({ expiresAt, deviceFlowExpiresAt }).where(eq(session.token, t));
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
    session: {
      update: {
        // ADR 0008 — enforce the device-flow 12h cap against better-auth's
        // rolling refresh. `getSession` past `updateAge` (default 1d) calls
        // `internalAdapter.updateSession(token, {expiresAt: now + expiresIn})`
        // and, because our global session.expiresIn defaults to 7d and the
        // refresh math triggers on the very first read of a 12h session,
        // that would silently walk the row back out to 7 days.
        //
        // We look up the row's `device_flow_expires_at` via the token in
        // the endpoint context (set by `getSession` before its updateSession
        // call) and, if the incoming write wants a later `expiresAt`,
        // downgrade it to the cap. Non-device sessions have `cap === null`
        // and the helper is a no-op — the password-auth refresh path is
        // unaffected. If we can't identify the session (no context.session)
        // we skip the cap; the cap is best-effort, and the sweeper-style
        // fallback would be a follow-up (BS#1494 review).
        before: async (data, ctx) => {
          const payload = data as { expiresAt?: Date | string | null } & Record<string, unknown>;
          if (!payload.expiresAt) return;
          const contextWithSession = (ctx ?? {}) as {
            context?: { session?: { session?: { token?: string | null } | null } | null };
          };
          const token = contextWithSession.context?.session?.session?.token;
          if (!token) return;
          try {
            const rows = await db
              .select({ cap: session.deviceFlowExpiresAt })
              .from(session)
              .where(eq(session.token, token))
              .limit(1);
            const cap = rows[0]?.cap ?? null;
            return capSessionUpdateAgainstDeviceFlow(payload, cap);
          } catch (error) {
            console.error('[device-auth] Session-update cap lookup failed:', error);
            Sentry.captureException(error, { tags: { subsystem: 'device-authorization' } });
            return;
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
