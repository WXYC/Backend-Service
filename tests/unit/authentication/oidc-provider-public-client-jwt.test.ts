import * as fs from 'fs';
import * as path from 'path';

// #1580 — Better-auth's `oidcProvider` plugin has two id_token signing paths.
// With `useJWTPlugin: false` (the default), token exchange signs with HS256
// using `client.clientSecret` as the HMAC key (see
// `node_modules/better-auth/dist/plugins/oidc-provider/index.mjs:649`). For a
// public client (`type: 'public'`, no `clientSecret`), that call reduces to
// `sign(new TextEncoder().encode(undefined))` → zero-length key → jose throws
// `JWSInvalid` → 500 out of the token endpoint.
//
// With `useJWTPlugin: true`, the token exchange delegates to the JWT plugin's
// asymmetric signer (RS256 / EdDSA), which requires no per-client secret and
// works uniformly for `web` and `public` clients. The JWT plugin is already
// registered ahead of `oidcProvider` in `auth.definition.ts`; we just need
// the flag set.
//
// This test pins the flag by source-scan (same technique as the
// `oidc-provider-schema.test.ts` neighbor). A behavior test would require
// spinning up the full better-auth instance against a live PG, which is over
// budget for a unit test. The source-scan catches the regression class that
// matters: someone flipping the flag off without understanding why it's on.

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function extractOidcProviderCall(source: string): string {
  // Slice from `oidcProvider({` through the matching close-brace. Follows
  // the same brace-counting technique the sibling schema test uses.
  const anchor = /oidcProvider\(\s*\{/g;
  const match = anchor.exec(source);
  if (!match) throw new Error('oidcProvider({ ... }) call not found in auth.definition.ts');
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error('oidcProvider({ ... }) close not found (unbalanced braces)');
}

describe('auth.definition.ts oidcProvider public-client id_token signing', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;
  let oidcCallBody: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
    const sourceNoComments = stripComments(source);
    oidcCallBody = extractOidcProviderCall(sourceNoComments);
  });

  it('sets useJWTPlugin: true so public-client token exchange does not sign HS256 with an empty HMAC key', () => {
    // Match `useJWTPlugin: true` (with optional whitespace variation). If
    // this ever flips to `false`, the public-client (`wxyc-canary`) path
    // regresses to the #1580 500-on-token-exchange failure.
    expect(oidcCallBody).toMatch(/useJWTPlugin\s*:\s*true/);
  });

  it('registers the jwt plugin before oidcProvider (required precondition for useJWTPlugin)', () => {
    // useJWTPlugin: true is a no-op — worse, it 500s at the token endpoint
    // with "JWT plugin is not enabled" — if the JWT plugin is not in the
    // plugin chain. Pin the ordering so a future refactor that reorders the
    // plugin array (or drops jwt()) breaks this test loudly at the source
    // level rather than at runtime.
    const jwtIdx = source.search(/\bjwt\s*\(\s*\{/);
    const oidcIdx = source.search(/\boidcProvider\s*\(\s*\{/);
    expect(jwtIdx).toBeGreaterThan(-1);
    expect(oidcIdx).toBeGreaterThan(-1);
    expect(jwtIdx).toBeLessThan(oidcIdx);
  });
});
