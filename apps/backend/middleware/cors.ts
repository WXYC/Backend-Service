import cors from 'cors';
import type { CorsOptions } from 'cors';
import type { Request, RequestHandler } from 'express';
import {
  PUBLIC_READ_CORS_ROUTES,
  isPublicReadGrant,
  resolveCorsOrigin,
  resolvePublicCorsOrigins,
} from '@wxyc/authentication';

/**
 * The credentialed contract `dj.wxyc.org` has had since BS#1107, unchanged.
 */
const CREDENTIALED_CORS_OPTIONS = {
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Internal-Key'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
} satisfies CorsOptions;

/**
 * The public contract, deliberately NOT a copy of the credentialed one.
 *
 * `methods` and `allowedHeaders` are what a preflight advertises back, so
 * reusing the credentialed values would answer a `wxyc.org` GET preflight with
 * `Access-Control-Allow-Methods: GET,POST,DELETE,PATCH` and an
 * `Access-Control-Allow-Headers` naming `Authorization` and `X-Internal-Key` —
 * telling the browser it may attempt writes and send an internal key on a
 * grant that exists solely for anonymous reads. Nothing downstream would honor
 * those (the routes are read-only and the credentialed branch owns everything
 * else), but a CORS grant should advertise exactly the surface it means to
 * open, and `PUBLIC_READ_CORS_ROUTES` is a GET-only allow-list.
 *
 * `Content-Type` stays because a browser sends it on a plain `fetch`;
 * `exposedHeaders` stays so a public page can still read `X-Request-Id` off a
 * response it is debugging.
 */
const PUBLIC_READ_CORS_OPTIONS = {
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: false,
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

  // Both payloads are fully determined once the env is resolved, so they are
  // built once here rather than re-spread on every request — this delegate runs
  // on every call to the whole API, not just the three public routes.
  const publicOptions: CorsOptions = { ...PUBLIC_READ_CORS_OPTIONS, origin: publicOrigins };
  const credentialedOptions: CorsOptions = { ...CREDENTIALED_CORS_OPTIONS, origin: credentialedOrigin };

  return cors<Request>((req, callback) => {
    callback(null, isPublicReadGrant(req, publicOrigins) ? publicOptions : credentialedOptions);
  });
}
