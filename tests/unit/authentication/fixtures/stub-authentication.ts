/**
 * Stands in for `@wxyc/authentication`, `@wxyc/database`, `@wxyc/observability` and `drizzle-orm` when
 * drive-capability-guard.ts bundles the real apps/auth/account-audit-middleware.ts (the BS#3717 turn queue). The
 * middleware reads the session through `auth.api.getSession` and the subject's capabilities through a drizzle
 * select; here both are answered by the fixture's in-memory better-auth instance, so the queue, `holdTurnAcross`
 * and the guard plugin all run for real.
 */
type Fixture = {
  auth: { api: { getSession: (input: { headers: Headers }) => Promise<unknown> } };
  readCapabilities: (id: string) => Promise<string[]>;
};
const fixture = (): Fixture => (globalThis as unknown as { __capabilityFixture: Fixture }).__capabilityFixture;

export const auth = { api: { getSession: (input: { headers: Headers }) => fixture().auth.api.getSession(input) } };
export const deriveStationSignupIpHash = (): string | null => null;
export const eq = (_column: unknown, value: unknown): unknown => value;
export const user = { id: 'id', capabilities: 'capabilities' };
export const db = {
  select: () => ({
    from: () => ({
      where: (id: string) => ({
        limit: async () => [{ capabilities: await fixture().readCapabilities(id) }],
      }),
    }),
  }),
};
export const recordAccountAuditEvent = (): Promise<void> => Promise.resolve();
export const getErrorReporter = () => ({ captureException: (): void => undefined });
export const parseBearerToken = (header: string | undefined): string | null => header?.replace(/^Bearer /, '') ?? null;
export { capabilityTurn } from '../../../../shared/authentication/src/capability-turn';
