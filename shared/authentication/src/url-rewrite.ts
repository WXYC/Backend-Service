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
