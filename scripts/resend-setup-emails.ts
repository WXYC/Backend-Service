/**
 * Resend account setup emails to users who haven't completed onboarding.
 *
 * Queries all users with hasCompletedOnboarding === false and triggers
 * better-auth's password reset flow for each, which sends the accountSetup
 * email template with a tokenized URL.
 *
 * Usage:
 *   npx tsx scripts/resend-setup-emails.ts [--dry-run]
 *
 * Requires:
 *   - Database connection (DB_HOST, DB_NAME, etc.)
 *   - Auth server running (BETTER_AUTH_URL)
 *   - SES configured (AWS_ACCESS_KEY_ID, etc.)
 *   - FRONTEND_SOURCE set to the frontend URL
 */

import { config } from 'dotenv';
config();

import { db, user } from '@wxyc/database';
import { auth } from '@wxyc/authentication';
import { eq } from 'drizzle-orm';

const dryRun = process.argv.includes('--dry-run');
const DELAY_MS = 500; // Avoid SES rate limiting

async function main() {
  console.log(dryRun ? '🔍 DRY RUN — no emails will be sent\n' : '📧 Sending setup emails...\n');

  const incompleteUsers = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.hasCompletedOnboarding, false));

  if (incompleteUsers.length === 0) {
    console.log('No users with incomplete onboarding found.');
    process.exit(0);
  }

  console.log(`Found ${incompleteUsers.length} user(s) with incomplete onboarding:\n`);

  for (const u of incompleteUsers) {
    console.log(`  ${u.email} (${u.name || 'no name'})`);
  }

  if (dryRun) {
    console.log('\nDry run complete. Run without --dry-run to send emails.');
    process.exit(0);
  }

  console.log('');

  const frontendUrl = process.env.FRONTEND_SOURCE || 'http://localhost:3000';
  let sent = 0;
  let failed = 0;

  for (const u of incompleteUsers) {
    try {
      await auth.api.requestPasswordReset({
        body: { email: u.email, redirectTo: `${frontendUrl}/onboarding` },
        headers: new Headers({ origin: frontendUrl }),
      });
      sent++;
      console.log(`  ✅ ${u.email}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ ${u.email}: ${message}`);
    }

    // Pace requests to avoid SES throttling
    if (sent + failed < incompleteUsers.length) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
