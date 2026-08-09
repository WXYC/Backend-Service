import cors from 'cors';
import type { CorsOptions } from 'cors';
import type { Request, RequestHandler } from 'express';
import {
  PUBLIC_READ_CORS_ROUTES,
  resolveCorsMode,
  resolveCorsOrigin,
  resolvePublicCorsOrigins,
} from '@wxyc/authentication';

/**
 * Everything about the CORS contract except which origins get it and whether
 * credentials ride along — those two are decided per request by
 * `resolveCorsMode` (BS#2061).
 */
const SHARED_CORS_OPTIONS = {
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Internal-Key'],
  exposedHeaders: ['X-Request-Id'],
} satisfies CorsOptions;

/**
 * The app's single `cors()` mount.
 *
 * Two contracts, one mount. `dj.wxyc.org` keeps the credentialed whitelist it
 * has had since BS#1107, unchanged down to the header bytes. The public
 * `wxyc.org` listener pages get `Access-Control-Allow-Origin` **without**
 * `Access-Control-Allow-Credentials`, and only on the three anonymous
 * flowsheet reads in `PUBLIC_READ_CORS_ROUTES` — they are static-export pages
 * calling `api.wxyc.org` from the browser (WXYC/wiki#91 Phase 4) and need to
 * read a response body, not to act as a signed-in user.
 *
 * One delegate rather than two stacked `cors()` layers, because in production
 * `FRONTEND_SOURCE` holds a single origin: `resolveCorsOrigin` returns a bare
 * string and the `cors` package emits it as ACAO unconditionally, so a
 * separate earlier layer's `https://wxyc.org` header would simply be
 * overwritten by `https://dj.wxyc.org` on the way out.
 *
 * `Vary: Origin` needs no handling here — the `cors` package pushes it for
 * both the string and the array form of `origin`, so it is already on every
 * response today and stays on every response after this change.
 *
 * Config is read once at construction, matching the pre-BS#2061 behavior of
 * evaluating `resolveCorsOrigin(process.env)` at mount time: an env change
 * needs a restart either way.
 */
export function buildCorsMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const credentialedOrigin = resolveCorsOrigin(env);
  const publicOrigins = resolvePublicCorsOrigins(env);

  if (publicOrigins.length > 0) {
    console.log(
      `[cors] Public read-only origins enabled on ${PUBLIC_READ_CORS_ROUTES.join(', ')}: ${publicOrigins.join(', ')} ` +
        '(no Access-Control-Allow-Credentials).'
    );
  }

  return cors<Request>((req, callback) => {
    callback(null, { ...SHARED_CORS_OPTIONS, ...resolveCorsMode(req, publicOrigins, credentialedOrigin) });
  });
}
