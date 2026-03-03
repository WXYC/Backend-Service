/**
 * Config controller - serves non-sensitive app configuration.
 *
 * GET /config is unauthenticated because the app needs it before it can
 * authenticate (bootstrap chicken-and-egg).
 */
import { RequestHandler } from 'express';

export interface AppConfig {
  posthogApiKey: string;
  posthogHost: string;
  requestOMaticUrl: string;
  apiBaseUrl: string;
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
