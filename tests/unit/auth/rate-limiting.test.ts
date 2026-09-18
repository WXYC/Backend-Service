import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Auth service rate limiting', () => {
  const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');

  it('imports express-rate-limit', () => {
    expect(authAppSource).toMatch(/express-rate-limit/);
  });

  it('configures a rate limiter with rateLimit()', () => {
    expect(authAppSource).toMatch(/rateLimit\s*\(/);
  });

  it('applies rate limiting to sensitive auth endpoints in production', () => {
    // The rate limiter targets specific mutation paths, not all /auth routes.
    expect(authAppSource).toMatch(/authMutationRateLimit/);
    expect(authAppSource).toMatch(/\/auth\/sign-in/);
    expect(authAppSource).toMatch(/\/auth\/sign-up/);
    expect(authAppSource).toMatch(/\/auth\/email-otp\/send-verification-otp/);
    // M1 (code review BS#2537 PR #2545): was '/auth/forget-password', a
    // string that matches no route in the installed better-auth version —
    // the real "forgot password" route is request-password-reset.
    expect(authAppSource).toMatch(/\/auth\/request-password-reset/);
  });

  it('disables rate limiting in test environments', () => {
    expect(authAppSource).toMatch(/isTestEnv/);
    expect(authAppSource).toMatch(/NODE_ENV.*test|USE_MOCK_SERVICES/);
  });

  // BS#2169. GET /auth/get-session carries TWO limiters, not one: an
  // IP-keyed abuse ceiling plus an identity-keyed fairness limiter. The
  // ceiling is a security requirement, not an optimization — see "Why the
  // second limiter is not optional" in plans/bs2169-get-session-limiter-key.md.
  // Neither the cookie nor the bearer token is verified at keyGenerator
  // time, so identity keying alone lets a caller mint a fresh bucket on
  // every request with a fabricated credential while still costing the
  // auth service a DB session lookup. isTestEnv disables the mounted
  // middleware entirely, so a source-text assertion is the only way to pin
  // that a future "simplification" dropping the ceiling fails CI.
  it('mounts both the IP-keyed abuse ceiling and the identity-keyed fairness limiter on /auth/get-session', () => {
    expect(authAppSource).toMatch(/getSessionIpRateLimit/);
    expect(authAppSource).toMatch(/getSessionIdentityRateLimit/);
    expect(authAppSource).toMatch(
      /app\.use\(\s*['"]\/auth\/get-session['"]\s*,\s*getSessionIpRateLimit\s*,\s*getSessionIdentityRateLimit\s*\)/
    );
  });

  // BS#2361. Two properties, and the source text is the only place to pin
  // either: isTestEnv disables every mounted limiter, so nothing exercises
  // this configuration at runtime in the suite.
  //
  //   1. The dedicated limiter is 60s/120 on the exact path, keyed by
  //      rateLimitKeyFromRequest. Anything tighter locks out the whole
  //      control room, which shares one IP.
  //   2. The path is NOT in `rateLimitedPaths`. That tier is 10 per 15
  //      minutes; three DJs fumbling a hand-copied code would take the
  //      station off the signup path for a quarter of an hour with no
  //      manager on site (issue body, "Do not add this to rateLimitedPaths").
  describe('station signup (BS#2361)', () => {
    it('mounts its own 60s/120 limiter on /auth/wxyc/station-signup, keyed by rateLimitKeyFromRequest', () => {
      expect(authAppSource).toMatch(
        /const stationSignupRateLimit = rateLimit\(\{[\s\S]*?windowMs: 60_000,[\s\S]*?limit: 120,[\s\S]*?keyGenerator: rateLimitKeyFromRequest,[\s\S]*?\}\);/
      );
      expect(authAppSource).toMatch(
        /app\.use\(\s*['"]\/auth\/wxyc\/station-signup['"]\s*,\s*stationSignupRateLimit\s*\)/
      );
    });

    it('keeps /auth/wxyc/station-signup out of the 10/15min rateLimitedPaths tier', () => {
      const tier = authAppSource.match(/const rateLimitedPaths = \[([\s\S]*?)\n {2}\];/)?.[1];
      expect(tier).toBeDefined();
      expect(tier).not.toMatch(/station-signup/);
    });

    // The route and its limiter are mounted only when the feature is on, so
    // a disabled deployment falls through to better-auth's catch-all and is
    // indistinguishable from one that never shipped the endpoint.
    it('gates both the limiter and the route on isStationSignupEnabled()', () => {
      expect(authAppSource).toMatch(
        /if \(isStationSignupEnabled\(\)\) \{[\s\S]*?const stationSignupRateLimit = rateLimit\(/
      );
      expect(authAppSource).toMatch(
        /if \(isStationSignupEnabled\(\)\) \{\s*app\.post\(\s*['"]\/auth\/wxyc\/station-signup['"]\s*,\s*stationSignupHandler\s*\);\s*\}/
      );
    });
  });

  // M3 (code review BS#2547, corrected on re-review): the three OTP
  // password-reset arms get their OWN limiters, not `rateLimitedPaths`'s
  // 10/15min brute-force tier — an OTP reset is a hand-copied-code flow, so
  // a shared IP-keyed bucket would let two DJs resetting before a shift
  // lock out everyone's sign-in from the control room's shared egress IP.
  // But the three paths split across TWO limiters, not one, by per-call
  // cost: `request-password-reset` and the `forget-password` alias both
  // send a real SES email on every call (no `resendStrategy` configured),
  // the identical operation and cost as the token-based
  // `/request-password-reset` flow, so they share ITS 10/15min tier rather
  // than the far looser budget a no-email donor (`checkRequestBanRateLimit`)
  // would justify; `email-otp/reset-password` sends nothing and is already
  // attempt-bounded server-side, so it gets a separate, looser 60s/30.
  // L2 (code review BS#2547): these assertions use the same idiom as the
  // station-signup block above — extract the exact source block and match
  // within it — rather than a bare
  // `.toMatch(/\/auth\/email-otp\/reset-password/)` against the whole file,
  // which would pass on the literal appearing anywhere at all (a comment,
  // a different limiter, a dead string) and assert nothing about which
  // limiter the path is actually registered on.
  describe('OTP password-reset limiters (BS#2547)', () => {
    it('mounts the two email-sending OTP paths on their own 10/15min limiter, matching the token reset flow', () => {
      expect(authAppSource).toMatch(
        /const otpPasswordResetSendRateLimit = rateLimit\(\{[\s\S]*?windowMs: 15 \* 60 \* 1000,[\s\S]*?limit: 10,[\s\S]*?keyGenerator: rateLimitKeyFromRequest,[\s\S]*?\}\);/
      );
      const mountBlock = authAppSource.match(
        /for \(const path of \[([\s\S]*?)\]\) \{\s*app\.use\(path, otpPasswordResetSendRateLimit\);\s*\}/
      )?.[1];
      expect(mountBlock).toBeDefined();
      expect(mountBlock).toMatch(/\/auth\/email-otp\/request-password-reset/);
      expect(mountBlock).toMatch(/\/auth\/forget-password\/email-otp/);
      // NOT the verify path — that's a distinct, looser limiter below.
      expect(mountBlock).not.toMatch(/\/auth\/email-otp\/reset-password'/);
    });

    it('mounts the verify-only OTP path on its own looser 60s/30 limiter, not the email-sending tier', () => {
      expect(authAppSource).toMatch(
        /const otpPasswordResetVerifyRateLimit = rateLimit\(\{[\s\S]*?windowMs: 60_000,[\s\S]*?limit: 30,[\s\S]*?keyGenerator: rateLimitKeyFromRequest,[\s\S]*?\}\);/
      );
      expect(authAppSource).toMatch(
        /app\.use\(\s*['"]\/auth\/email-otp\/reset-password['"]\s*,\s*otpPasswordResetVerifyRateLimit\s*\)/
      );
    });

    // Regression guard for exactly the mistake a future edit could
    // reintroduce: merging the two tiers back into one instance would
    // silently restore the mail-bomb exposure this split fixed.
    it('mounts the email-sending paths and the verify path on DIFFERENT limiter instances', () => {
      const sendMount = authAppSource.match(/app\.use\(path, (otpPasswordResetSendRateLimit)\);/)?.[1];
      const verifyMount = authAppSource.match(
        /app\.use\(\s*['"]\/auth\/email-otp\/reset-password['"]\s*,\s*(otpPasswordResetVerifyRateLimit)\s*\)/
      )?.[1];
      expect(sendMount).toBe('otpPasswordResetSendRateLimit');
      expect(verifyMount).toBe('otpPasswordResetVerifyRateLimit');
      expect(sendMount).not.toBe(verifyMount);
    });

    it('keeps the three OTP paths out of the 10/15min rateLimitedPaths tier', () => {
      const tier = authAppSource.match(/const rateLimitedPaths = \[([\s\S]*?)\n {2}\];/)?.[1];
      expect(tier).toBeDefined();
      expect(tier).not.toMatch(/email-otp\/request-password-reset/);
      expect(tier).not.toMatch(/email-otp\/reset-password/);
      expect(tier).not.toMatch(/forget-password\/email-otp/);
    });
  });

  // BS#2554 (parent epic #2534, decision recorded 2026-09-18): the whole
  // /auth/admin prefix gets its OWN limiter, not rateLimitedPaths' 10/15min
  // brute-force tier — folding it in would share sign-in's bucket and let
  // routine admin traffic from the control room's one shared egress IP 429
  // sign-in for everyone in the building (the PR #2550 lesson). Source-block
  // extraction throughout, not a bare `.toMatch` against the whole file
  // (PR #2550's L2 finding): a loose substring match is what let a dead path
  // sit pinned-and-green.
  describe('admin-prefix limiter (BS#2554)', () => {
    it('mounts its own 100/15min limiter on /auth/admin, keyed by rateLimitKeyFromRequest', () => {
      expect(authAppSource).toMatch(
        /const adminPrefixRateLimit = rateLimit\(\{[\s\S]*?windowMs: 15 \* 60 \* 1000,[\s\S]*?limit: 100,[\s\S]*?keyGenerator: rateLimitKeyFromRequest,[\s\S]*?\}\);/
      );
      expect(authAppSource).toMatch(/app\.use\(\s*['"]\/auth\/admin['"]\s*,\s*adminPrefixRateLimit\s*\)/);
    });

    it('keeps /auth/admin out of the 10/15min rateLimitedPaths tier', () => {
      const tier = authAppSource.match(/const rateLimitedPaths = \[([\s\S]*?)\n {2}\];/)?.[1];
      expect(tier).toBeDefined();
      expect(tier).not.toMatch(/\/auth\/admin/);
    });

    // Registration order is load-bearing here, not merely tidy: Express
    // matches-and-terminates, so a limiter mounted after the account-audit
    // prefix mount would still let every over-budget request pay for the
    // audit mount's unconditional getSession call and its
    // account_audit_event INSERT on its way to a 429 — bounding nothing the
    // issue actually costs. See the limiter's own comment in app.ts.
    it('mounts the admin-prefix limiter ahead of the account-audit prefix mount', () => {
      const limiterIndex = authAppSource.indexOf("app.use('/auth/admin', adminPrefixRateLimit)");
      const auditMountIndex = authAppSource.indexOf("app.use('/auth/admin', adminPrefixAuditMiddleware())");
      expect(limiterIndex).toBeGreaterThan(-1);
      expect(auditMountIndex).toBeGreaterThan(-1);
      expect(limiterIndex).toBeLessThan(auditMountIndex);
    });
  });
});
