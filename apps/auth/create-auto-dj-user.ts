/**
 * Idempotent startup bootstrap for the auto-DJ service account.
 *
 * The auto-dj-orchestrator is the sole automated flowsheet writer for the
 * auto-DJ system and signs in headlessly via `POST /sign-in/email`, so it needs
 * a service account with a *known* password. The normal provisioning paths
 * can't produce one:
 *   - self-signup is disabled (`disableSignUp: true`);
 *   - `POST /auth/admin/provision-user` rejects a caller-supplied password —
 *     DJs set theirs by clicking an emailed invite link, which a headless
 *     service account can never do.
 *
 * So the account is minted by server-side code that calls `provisionUser()`
 * with an explicit password, exactly as `createDefaultUser()` does. See
 * WXYC/Backend-Service#1644.
 *
 * Design notes:
 *   - Gated by `CREATE_AUTO_DJ_USER`, defaulting off, so a stray deploy in an
 *     unrelated environment never tries to mint the account.
 *   - Idempotent: skips if the user already exists (`provisionUser` 409s on an
 *     existing user). Safe to run on every redeploy.
 *   - Must run AFTER the default-user/org bootstrap. Unlike `createDefaultUser`
 *     this does NOT create the org; if the org is missing (e.g. an env with the
 *     auto-dj flag on but the default-user flag off) it skips defensively
 *     rather than letting `provisionUser` 404.
 *   - Least privilege: `dj` member role only. `dj` is deliberately outside the
 *     admin-sync set (`stationManager`/`admin`/`owner`), so the global
 *     `user.role` stays null and the account can never act as a Better-Auth
 *     admin.
 *   - Out of scope: password rotation. Skip-if-exists creates but never
 *     updates — same limitation `createDefaultUser` has today.
 */

import * as Sentry from '@sentry/node';
import { auth } from '@wxyc/authentication';
import { provisionUser } from './provision-user';

export const createAutoDjUser = async (): Promise<void> => {
  if (process.env.CREATE_AUTO_DJ_USER !== 'TRUE') return;

  try {
    const email = process.env.AUTO_DJ_EMAIL;
    const password = process.env.AUTO_DJ_PASSWORD;
    const organizationSlug = process.env.DEFAULT_ORG_SLUG;

    if (!email || !password || !organizationSlug) {
      throw new Error(
        'Auto-DJ user credentials are not fully set in environment variables (AUTO_DJ_EMAIL, AUTO_DJ_PASSWORD, DEFAULT_ORG_SLUG).'
      );
    }

    const context = await auth.$context;

    const existingUser = await context.internalAdapter.findUserByEmail(email);
    if (existingUser) {
      console.log('Auto-DJ user already exists, skipping creation.');
      return;
    }

    // The default org must already exist (this bootstrap runs after
    // createDefaultUser). We do NOT create it here — if it's missing, skip
    // rather than 404, so a misconfigured env fails soft.
    const existingOrganization = await context.adapter.findOne<{ id: string }>({
      model: 'organization',
      where: [{ field: 'slug', value: organizationSlug }],
    });
    if (!existingOrganization) {
      console.warn(
        `[AUTO-DJ USER] Organization "${organizationSlug}" not found; skipping auto-dj user creation. ` +
          'Ensure the default org is bootstrapped first.'
      );
      return;
    }

    // realName omitted — no legal person behind a service account, so the
    // PII/legal-name field stays empty. `role: 'dj'` keeps `user.role` null.
    await provisionUser({
      email,
      username: 'autodj',
      name: 'Auto DJ', // required (notNull); internal, never surfaced publicly
      djName: 'Auto DJ', // the public HANDLE — what appears on-air
      organizationSlug,
      role: 'dj',
      password,
    });

    console.log('Auto-DJ user created successfully with dj role.');
  } catch (error) {
    console.error('[AUTO-DJ USER] Error creating auto-dj user:', error);
    Sentry.captureException(error, { level: 'warning', tags: { subsystem: 'auto-dj-user' } });
  }
};
