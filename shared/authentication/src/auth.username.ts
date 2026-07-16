/**
 * Username validation shared between admin provisioning and the better-auth
 * `username` plugin. Mirrors the plugin's defaults so an account created via
 * `provisionUser()` is guaranteed to be loginable through `signIn.username`.
 *
 * The plugin's `defaultUsernameValidator` is `/^[a-zA-Z0-9_.]+$/` with a
 * length range of [3, 30]. Any future relaxation needs the plugin's
 * `usernameValidator` / `minUsernameLength` / `maxUsernameLength` options
 * updated in lockstep.
 */

export const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;

export type UsernameValidationError =
  { kind: 'too-short'; min: number } | { kind: 'too-long'; max: number } | { kind: 'invalid-characters' };

export function validateUsername(username: string): UsernameValidationError | null {
  if (username.length < MIN_USERNAME_LENGTH) {
    return { kind: 'too-short', min: MIN_USERNAME_LENGTH };
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return { kind: 'too-long', max: MAX_USERNAME_LENGTH };
  }
  if (!USERNAME_REGEX.test(username)) {
    return { kind: 'invalid-characters' };
  }
  return null;
}

export function formatUsernameError(error: UsernameValidationError): string {
  switch (error.kind) {
    case 'too-short':
      return `Username must be at least ${error.min} characters.`;
    case 'too-long':
      return `Username must be at most ${error.max} characters.`;
    case 'invalid-characters':
      return 'Username may only contain letters, numbers, underscores, and dots (no spaces).';
  }
}
