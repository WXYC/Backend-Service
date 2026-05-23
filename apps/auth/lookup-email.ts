/**
 * Resolve a login identifier to a verification email address.
 *
 * The login UI accepts either a username or an email in a single field.
 * Email-keyed flows (OTP send/verify) need the email, so the client calls
 * this resolver when the identifier contains no '@'. Identifiers that
 * already look like emails are echoed back unchanged — the OTP send will
 * silently no-op for unknown emails (better-auth `disableSignUp: true`).
 */

import { auth } from '@wxyc/authentication';

export async function lookupEmailByIdentifier(identifier: string): Promise<string | null> {
  if (identifier.includes('@')) {
    return identifier;
  }

  const context = await auth.$context;
  const user = await context.adapter.findOne<{ email: string }>({
    model: 'user',
    where: [{ field: 'username', value: identifier }],
  });

  return user?.email ?? null;
}
