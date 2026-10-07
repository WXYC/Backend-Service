import type { DataCollection } from '@sentry/core';

/**
 * Header, cookie and query-key snippets Sentry 10 withheld by default
 * (`PII_HEADER_SNIPPETS` in 10.75.0). They catch `X-Forwarded-For`,
 * `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `Remote-User` and similar,
 * on top of the sensitive-key scrub (auth, token, password, cookie, ...)
 * Sentry still always applies.
 */
const PII_HEADER_SNIPPETS: readonly string[] = ['forwarded', '-ip', 'remote-', 'via', '-user'];

/** A fresh copy per field, so no two fields share one mutable array. */
const denyPiiHeaders = (): { deny: string[] } => ({ deny: [...PII_HEADER_SNIPPETS] });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The `dataCollection` option for `Sentry.init`, restoring what Sentry 10
 * collected when no option was set (BS#3004). The three app preloads pass it;
 * the `jobs/*` loggers do not depend on this package yet (BS#3005).
 *
 * Sentry 11 made collection permissive by default: end-user IPs on events and
 * spans, IP-bearing request headers, full query strings and incoming request
 * bodies, none of which 10.75.0 sent. `sendDefaultPii` no longer exists in
 * v11, so this option is the only lever. **Every field is spelled out on
 * purpose**: a field left out falls back to the permissive default, so
 * `{ userInfo: false }` alone would still send headers, query strings and
 * bodies.
 *
 * `queues` has no v10 counterpart and is off. `graphQL`,
 * `stackFrameVariables` and `frameContextLines` carry no end-user data and
 * keep their v10 values for parity.
 */
export const SENTRY_DATA_COLLECTION: DataCollection = deepFreeze({
  userInfo: false,
  cookies: denyPiiHeaders(),
  httpHeaders: { request: denyPiiHeaders(), response: denyPiiHeaders() },
  urlQueryParams: denyPiiHeaders(),
  httpBodies: [],
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  graphQL: { document: true, variables: true },
  stackFrameVariables: true,
  frameContextLines: 7,
  // `Required` makes a field dropped here, or one a future SDK adds, a compile
  // error rather than a silent fall back to the permissive default.
} satisfies Required<DataCollection>);
