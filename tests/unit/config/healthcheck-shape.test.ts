/**
 * Source-grep regression tests for the /healthcheck response shape.
 *
 * Both `apps/backend/app.ts` and `apps/auth/app.ts` must return bodies that
 * conform to `HealthCheckResponse` from `@wxyc/shared` (added in v0.13.0):
 * `{status: 'healthy' | 'degraded' | 'unhealthy'}` plus an optional
 * `services` map per `ReadinessResponse`. wxyc-canary's check is `r.ok`-only,
 * so the body change is non-breaking, but we still pin the shape so future
 * edits don't drift away from the cross-language contract.
 *
 * Source-grep style mirrors `auth-healthcheck-ip-header.test.ts`: we assert
 * what the route bodies look like by reading app.ts as a string. This
 * sidesteps the need to spin up Express + the database for what is really a
 * contract assertion. The integration test `tests/integration/metadata.spec.js`
 * exercises the live request/response path.
 *
 * Background: WXYC/Backend-Service#804, WXYC/wxyc-shared#108.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const backendAppSource = readFileSync(resolve(__dirname, '../../../apps/backend/app.ts'), 'utf-8');
const authAppSource = readFileSync(resolve(__dirname, '../../../apps/auth/app.ts'), 'utf-8');

describe('/healthcheck response shape (HealthCheckResponse from @wxyc/shared)', () => {
  describe('apps/backend/app.ts', () => {
    it('imports the HealthCheckResponse type from @wxyc/shared/dtos', () => {
      expect(backendAppSource).toMatch(
        /import\s+type\s+\{[^}]*\bHealthCheckResponse\b[^}]*\}\s+from\s+['"]@wxyc\/shared\/dtos['"]/
      );
    });

    it('healthy success body uses status: "healthy" with a services map reporting database: "ok"', () => {
      // Match `status: 'healthy'` (single or double quote) somewhere after the
      // try/await db.execute block, and a `database: 'ok'` entry. Keeping the
      // assertion narrow so cosmetic diff (e.g. property order) doesn't trip.
      expect(backendAppSource).toMatch(/status\s*:\s*['"]healthy['"]/);
      expect(backendAppSource).toMatch(/database\s*:\s*['"]ok['"]/);
    });

    it('failure body uses status: "unhealthy" with services.database: "unavailable" and 503 status', () => {
      expect(backendAppSource).toMatch(/status\s*:\s*['"]unhealthy['"]/);
      expect(backendAppSource).toMatch(/database\s*:\s*['"]unavailable['"]/);
      // The catch branch must still set 503 (canary alarm depends on it).
      expect(backendAppSource).toMatch(/\.status\(\s*503\s*\)/);
    });

    it('does not return the legacy {message: "Healthy!"} shape', () => {
      expect(backendAppSource).not.toMatch(/message\s*:\s*['"]Healthy!['"]/);
    });
  });

  describe('apps/auth/app.ts', () => {
    it('imports the HealthCheckResponse type from @wxyc/shared/dtos', () => {
      expect(authAppSource).toMatch(
        /import\s+type\s+\{[^}]*\bHealthCheckResponse\b[^}]*\}\s+from\s+['"]@wxyc\/shared\/dtos['"]/
      );
    });

    it('healthy success body uses status: "healthy" with a services map reporting auth: "ok"', () => {
      expect(authAppSource).toMatch(/status\s*:\s*['"]healthy['"]/);
      expect(authAppSource).toMatch(/auth\s*:\s*['"]ok['"]/);
    });

    it('failure body uses status: "unhealthy" with services.auth: "unavailable"', () => {
      expect(authAppSource).toMatch(/status\s*:\s*['"]unhealthy['"]/);
      expect(authAppSource).toMatch(/auth\s*:\s*['"]unavailable['"]/);
    });

    it('preserves status codes: forwards /auth/ok response.status on success, 500 in the catch branch', () => {
      // Per #804: "Do NOT change status codes". The current auth handler
      // forwards whatever /auth/ok returns (so a degraded auth surface gets
      // the same non-2xx the backend got) and falls back to 500 on a
      // network/parse failure. Preserve both branches.
      expect(authAppSource).toMatch(/\.status\(\s*response\.status\s*\)/);
      expect(authAppSource).toMatch(/\.status\(\s*500\s*\)/);
    });

    it('does not return the legacy {message: "Healthcheck failed: ..."} shape', () => {
      expect(authAppSource).not.toMatch(/message\s*:\s*['"]Healthcheck failed/);
    });

    it('preserves the X-Real-IP loopback header (regression for #774)', () => {
      // The new handler must keep passing X-Real-IP: 127.0.0.1 to /auth/ok
      // so better-auth's getIp doesn't latch the warning that disables its
      // rate limiter (see #765 and the auth-healthcheck-ip-header test).
      const fetchBlock = authAppSource.match(/fetch\(\s*`\$\{authServiceUrl\}\/auth\/ok`[\s\S]*?\)/);
      expect(fetchBlock).not.toBeNull();
      if (fetchBlock) {
        expect(fetchBlock[0]).toMatch(/['"]X-Real-IP['"]\s*:\s*['"]127\.0\.0\.1['"]/i);
      }
    });
  });
});
