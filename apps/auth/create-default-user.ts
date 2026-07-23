/**
 * Idempotent startup bootstrap for the environment's default admin user
 * (+ its organization). Gated by `CREATE_DEFAULT_USER`, defaulting off; mints a
 * `stationManager` account from the `DEFAULT_USER_*` env vars via
 * `provisionUser()`, bootstrapping the default organization first if missing.
 *
 * Extracted from `app.ts` (mirroring `create-auto-dj-user.ts`) so the bootstrap
 * is unit-testable without importing `app.ts`, which self-executes `listen()`.
 *
 * Idempotency (BS#1670): skips if a user with the configured email **or**
 * username already exists. The username check matters because `auth_user`
 * carries its own unique index on `username`, independent of `id`/`email`. A
 * seeded fixture row (e.g. the e2e `test_dj1`) or any prior row can already own
 * the username while its email differs from `DEFAULT_USER_EMAIL`; without the
 * username guard the email lookup misses, `provisionUser` INSERTs a fresh id,
 * and the insert trips `auth_user_username_key` mid-run — the e2e flake in
 * WXYC/dj-site#579 / BS#1670. Converging on a username match makes the
 * bootstrap idempotent regardless of which env/config enabled it or whether the
 * configured email matches the existing row.
 *
 * This bootstrap-only convergence is deliberately NOT pushed into
 * `provisionUser()`: the interactive admin path (`POST /auth/admin/provision-user`)
 * should still surface a username collision as an error, not silently skip.
 */

import * as Sentry from '@sentry/node';
import { auth } from '@wxyc/authentication';
import { provisionUser } from './provision-user';

export const createDefaultUser = async (): Promise<void> => {
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

    // BS#1670: `auth_user.username` has its own unique index, independent of
    // id/email. If a row (e.g. a seeded e2e `test_dj1`) already owns this
    // username under a different email, the email lookup above misses but a
    // fresh provision would trip `auth_user_username_key` mid-run. Converge by
    // skipping when the username is already taken.
    const existingByUsername = await context.adapter.findOne<{ id: string }>({
      model: 'user',
      where: [{ field: 'username', value: username }],
    });

    if (existingByUsername) {
      console.log('Default user username already exists, skipping creation.');
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
