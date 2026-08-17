import * as fs from 'fs';
import * as path from 'path';

// BS#2169. Pins auth.definition.ts's `rateLimit.customRules` block against
// two hazards:
//   1. A `better-auth` upgrade that reorders resolveRateLimitConfig's
//      `if (resolved)` / `if (resolved === false)` checks (the ordering
//      that makes `false` short-circuit before the rate-limit store is
//      touched is an implementation detail of a minified upstream build,
//      not a documented contract).
//   2. Someone widening `customRules` later to also cover `/token` or
//      `/sign-in*`, which the issue's Constraints section requires to stay
//      IP-keyed.
//
// Asserted over source text, not by import: `@wxyc/authentication` is
// moduleNameMapped to a mock (jest.unit.config.ts), and importing
// auth.definition.ts directly pulls in better-auth ESM subpaths that are
// neither mapped nor in transformIgnorePatterns. Every existing config
// assertion in this repo already uses this readFileSync + regex idiom (see
// cookie-config.test.ts, session-config.test.ts).
describe('auth.definition.ts rate-limit customRules', () => {
  const authDefPath = path.resolve(__dirname, '../../../shared/authentication/src/auth.definition.ts');
  let source: string;
  let customRulesBlock: string;

  beforeAll(() => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    source = fs.readFileSync(authDefPath, 'utf-8');
    // Scoped to the customRules object literal itself, not the whole file:
    // /auth/token, sign-in, and /device/token all appear elsewhere in
    // auth.definition.ts for unrelated reasons, so a whole-file assertion
    // would false-fail on day one.
    const match = /customRules:\s*\{[\s\S]*?\}/.exec(source);
    expect(match).not.toBeNull();
    customRulesBlock = match ? match[0] : '';
  });

  it("disables better-auth's internal limiter for /get-session", () => {
    // The key is `/get-session`, not `/auth/get-session` — normalizePathname
    // strips the basePath before matching. `false` short-circuits
    // resolveRateLimitConfig before the rate-limit store is ever touched.
    expect(customRulesBlock).toMatch(/['"]\/get-session['"]\s*:\s*false/);
  });

  it('does not touch /token or /sign-in* bucketing — they stay IP-keyed by design', () => {
    expect(customRulesBlock).not.toMatch(/token/);
    expect(customRulesBlock).not.toMatch(/sign-in/);
  });
});
