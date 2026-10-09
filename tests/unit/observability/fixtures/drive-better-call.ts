/**
 * Driven by console-redaction.test.ts in a child process (better-auth is
 * ESM-only, so jest cannot load it). Mounts a route that throws a failed-query
 * error on the auth app's copy of the real better-auth 1.6 router, which nests better-call's router,
 * sends it a request, and prints the response status. What the router logs goes
 * to the child's real stdout/stderr.
 */
import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { installConsoleRedaction, redactLogValue } from '../../../../shared/observability/src/index';
import { authLogHandler, setAuthLogRedactor } from '../../../../shared/authentication/src/auth-log';

const sentinel = process.argv[2];
const mode = process.argv[3];

if (mode === 'wrapped') {
  setAuthLogRedactor(redactLogValue);
  installConsoleRedaction();
}

// Defined the way postgres.js's queryError does: non-writable, non-configurable.
const cause = new Error('null value in column "real_name" violates not-null constraint');
Object.defineProperties(cause, {
  parameters: { value: [sentinel, 'u1'] },
  args: { value: [sentinel, 'u1'] },
});
const failure = new DrizzleQueryError(
  'update "auth_user" set "real_name" = $1 where "id" = $2',
  [sentinel, 'u1'],
  cause
);

const auth = betterAuth({
  baseURL: 'http://localhost:8082',
  secret: 'a-test-secret-that-is-long-enough-for-better-auth-1234',
  database: memoryAdapter({}),
  logger: { log: authLogHandler },
  plugins: [
    {
      id: 'boom',
      endpoints: {
        boom: createAuthEndpoint('/boom', { method: 'POST' }, () => {
          throw failure;
        }),
      },
    },
  ],
});

const response = await auth.handler(new Request('http://localhost:8082/api/auth/boom', { method: 'POST' }));
console.log(`STATUS ${response.status} ${JSON.stringify(await response.text())}`);
