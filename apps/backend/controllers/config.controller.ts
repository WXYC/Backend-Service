/**
 * Config controller.
 *
 * GET /config — unauthenticated, non-sensitive bootstrap configuration.
 * GET /config/secrets — authenticated, serves API credentials the app
 *   needs to call third-party services directly (e.g. Discogs).
 */
import { RequestHandler } from 'express';

export interface AppConfig {
  posthogApiKey: string;
  posthogHost: string;
  requestOMaticUrl: string;
  apiBaseUrl: string;
}

export interface AppSecrets {
  discogsApiKey: string;
  discogsApiSecret: string;
}

/**
 * GET /config
 *
 * Returns public, non-sensitive configuration for app bootstrap.
 * Cache-Control: public, max-age=3600 (1 hour).
 */
export const getConfig: RequestHandler = (_req, res) => {
  const config: AppConfig = {
    posthogApiKey: process.env.POSTHOG_API_KEY || '',
    posthogHost: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
    requestOMaticUrl: process.env.REQUEST_O_MATIC_URL || '',
    apiBaseUrl: process.env.API_BASE_URL || 'https://api.wxyc.org',
  };

  res.set('Cache-Control', 'public, max-age=3600');
  res.status(200).json(config);
};

/**
 * GET /config/secrets
 *
 * Returns API credentials for third-party services. Requires device
 * session authentication.
 * Cache-Control: private, max-age=3600 (1 hour, not shared caches).
 */
export const getSecrets: RequestHandler = (_req, res) => {
  const secrets: AppSecrets = {
    discogsApiKey: process.env.DISCOGS_API_KEY || '',
    discogsApiSecret: process.env.DISCOGS_API_SECRET || '',
  };

  res.set('Cache-Control', 'private, max-age=3600');
  res.status(200).json(secrets);
};
