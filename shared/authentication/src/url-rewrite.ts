/**
 * Rewrites a URL to use the frontend host and protocol while preserving path and query params.
 * This allows email links to point to the frontend domain while keeping all Better Auth parameters intact.
 */
export const rewriteUrlForFrontend = (url: string): string => {
  try {
    const parsed = new URL(url);
    const frontend = new URL(process.env.FRONTEND_SOURCE || 'http://localhost:3000');
    parsed.host = frontend.host;
    parsed.protocol = frontend.protocol;
    return parsed.toString();
  } catch {
    // If URL parsing fails, return original URL
    return url;
  }
};

/**
 * Rewrite a Better Auth reset/setup URL to the frontend host and, when a
 * dedicated reset-page path is configured (`PASSWORD_RESET_REDIRECT_URL`),
 * attach it as a `redirectTo` query param. Extracted from `auth.definition.ts`
 * so both the `sendResetPassword` hook and the `createAndSendAccountSetupInvite`
 * helper build byte-identical links.
 */
export const buildResetUrl = (url: string, redirectTo?: string): string => {
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
