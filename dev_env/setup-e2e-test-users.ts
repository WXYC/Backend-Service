/**
 * E2E Test User Setup Script
 *
 * This script creates test users with proper password hashes for E2E testing.
 * Run this script after the database is seeded to set up passwords.
 *
 * Usage:
 *   npx ts-node dev_env/setup-e2e-test-users.ts
 *
 * Or from the Backend-Service root:
 *   npm run setup:e2e-users
 */

import { config } from 'dotenv';
config();

const TEST_PASSWORD = 'testpassword123';
const TEMP_PASSWORD = 'temppass123'; // For incomplete users (onboarding flow)

interface TestUser {
  id: string;
  username: string;
  password?: string; // Uses TEST_PASSWORD if not specified
}

const TEST_USERS: TestUser[] = [
  { id: 'test-member-id-000000000000000001', username: 'test_member' },
  { id: 'test-dj1-id-00000000000000000001', username: 'test_dj1' },
  { id: 'test-dj2-id-00000000000000000002', username: 'test_dj2' },
  { id: 'test-md-id-0000000000000000001', username: 'test_music_director' },
  { id: 'test-sm-id-0000000000000000001', username: 'test_station_manager' },
  { id: 'test-incomplete-id-0000000000001', username: 'test_incomplete', password: TEMP_PASSWORD },
  { id: 'test-deletable-id-00000000000001', username: 'test_deletable_user' },
  { id: 'test-promotable-id-0000000000001', username: 'test_promotable_user' },
  { id: 'test-demotable-sm-id-000000000001', username: 'test_demotable_sm' },
  { id: 'test-reset1-id-000000000000000001', username: 'test_reset1' },
  { id: 'test-reset2-id-000000000000000002', username: 'test_reset2' },
  { id: 'test-adminreset1-id-00000000001', username: 'test_adminreset1' },
];

async function setUpTestUsers() {
  try {
    // Import auth context to get password utility
    const { auth } = await import('@wxyc/authentication');
    const context = await auth.$context;
    const { db, account } = await import('@wxyc/database');
    const { eq } = await import('drizzle-orm');

    console.log('Setting up E2E test users with passwords...\n');

    // Hash both passwords upfront
    const hashedTestPassword = await context.password.hash(TEST_PASSWORD);
    const hashedTempPassword = await context.password.hash(TEMP_PASSWORD);
    console.log('Passwords hashed successfully');

    for (const user of TEST_USERS) {
      try {
        // Use custom password if specified, otherwise default test password
        const passwordHash = user.password
          ? user.password === TEMP_PASSWORD
            ? hashedTempPassword
            : await context.password.hash(user.password)
          : hashedTestPassword;

        // Update the account with the password hash
        const result = await db.update(account).set({ password: passwordHash }).where(eq(account.userId, user.id));

        const passwordType = user.password ? user.password : TEST_PASSWORD;
        console.log(`[+] Set password for ${user.username} (${passwordType})`);
      } catch (error) {
        console.error(`[-] Failed to set password for ${user.username}:`, error);
      }
    }

    console.log('\nE2E test user setup complete!');
    console.log(`Most test users have password: ${TEST_PASSWORD}`);
    console.log(`Incomplete user has password: ${TEMP_PASSWORD}`);
    process.exit(0);
  } catch (error) {
    console.error('Failed to set up E2E test users:', error);
    process.exit(1);
  }
}

setUpTestUsers();
