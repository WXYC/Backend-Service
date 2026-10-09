import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { authLogHandler, setAuthLogRedactor } from '../../../shared/authentication/src/auth-log';
import { redactLogValue } from '@wxyc/observability';

// A failed `auth_user.real_name` write quotes the legal name in the error's
// message, stack and params (BS#3054). better-auth logs the raw caught error
// through its `logger.log`; the auth app logs the same errors itself.
const SENTINEL = 'Test Reviewer';
const failedWrite = () =>
  new DrizzleQueryError(
    'update "auth_user" set "real_name" = $1 where "id" = $2',
    [SENTINEL, 'u1'],
    new Error('timeout')
  );

const read = (relPath: string) => readFileSync(resolve(__dirname, '../../..', relPath), 'utf8');

describe('authLogHandler', () => {
  afterEach(() => {
    setAuthLogRedactor((value) => value);
    jest.restoreAllMocks();
  });

  it('writes better-auth errors to console.error with bound parameters removed once the app registers the redactor', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    setAuthLogRedactor(redactLogValue);

    authLogHandler('error', 'INTERNAL_SERVER_ERROR', failedWrite());

    const [line, logged] = spy.mock.calls[0];
    expect(line).toContain('ERROR [Better Auth]: INTERNAL_SERVER_ERROR');
    expect(JSON.stringify([line, logged], Object.getOwnPropertyNames(logged))).not.toContain(SENTINEL);
    expect(logged).toBeInstanceOf(DrizzleQueryError);
  });

  it('redacts a message string that quotes the failed query', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    setAuthLogRedactor(redactLogValue);

    authLogHandler('error', failedWrite().message);

    expect(String(spy.mock.calls[0][0])).not.toContain(SENTINEL);
  });

  it.each([
    ['warn', 'warn'],
    ['info', 'log'],
    ['debug', 'log'],
  ] as const)('writes %s through console.%s', (level, method) => {
    const spy = jest.spyOn(console, method).mockImplementation();

    authLogHandler(level, 'hello');

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// The handlers below run on paths that write `auth_user.real_name`; none of them
// is reachable without the database, so pin the wiring in the source.
describe('auth app wiring', () => {
  const app = read('apps/auth/app.ts');

  it('registers the redactor for better-auth logging', () => {
    expect(app).toContain('setAuthLogRedactor(redactLogValue);');
    expect(read('shared/authentication/src/auth.definition.ts')).toContain('logger: { log: authLogHandler }');
  });

  it.each(['PROVISION USER', 'UPDATE IDENTITY', 'STATION SIGNUP', 'COMPLETE ONBOARDING'])(
    'logs the unexpected [%s] error through redactQueryParams',
    (tag) => {
      expect(app).toContain(`console.error('[${tag}] Unexpected error:', redactQueryParams(error));`);
    }
  );
});
