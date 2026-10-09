import { readFileSync } from 'fs';
import { resolve } from 'path';
import { inspect } from 'util';
import { authLogHandler, resetAuthLogRedactor } from '../../../shared/authentication/src/auth-log';
import { installAuthLogRedaction } from '../../../apps/auth/log-redaction';
import { realDrizzleQueryError } from '../../utils/postgres-js-errors';

// The registration module needs only the log seam from the authentication package, and the real one.
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth-log'));

// A failed `auth_user.real_name` write quotes the legal name in the error's message, stack and params
// (BS#3054). better-auth logs the raw caught error through its `logger.log`, and better-call's router
// through `console.error`; the auth app logs the same errors itself.
const SENTINEL = 'Test Reviewer';
const failedWrite = () => realDrizzleQueryError([SENTINEL, 'u1']);
const everything = (calls: unknown[]) => inspect(calls, { depth: 10, showHidden: true });

describe('authLogHandler before any redactor is registered', () => {
  beforeEach(resetAuthLogRedactor);
  afterEach(() => jest.restoreAllMocks());

  it('fails closed: an error is logged as its class name and a placeholder, never its message or itself', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();

    authLogHandler('error', 'INTERNAL_SERVER_ERROR', failedWrite());

    const [line, logged] = spy.mock.calls[0];
    expect(everything(spy.mock.calls)).not.toContain(SENTINEL);
    expect(line).toContain('ERROR [Better Auth]: INTERNAL_SERVER_ERROR');
    expect(logged).toBe('[DrizzleQueryError: details withheld, no log redactor registered]');
  });

  it('cuts a message string that quotes the failed query at its params', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();

    authLogHandler('error', failedWrite().message);

    expect(everything(spy.mock.calls)).not.toContain(SENTINEL);
    expect(String(spy.mock.calls[0][0])).toContain('update "auth_user"');
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

// `resetAuthLogRedactor` assigns the fail-closed redactor itself, so only a fresh module instance shows what a
// process that never registers one (the backend, jobs, scripts) starts with.
describe('authLogHandler in a process that never registers a redactor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts fail closed: the first log of a failed write withholds the bound value', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const error = failedWrite();

    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('../../../shared/authentication/src/auth-log')>(
        '../../../shared/authentication/src/auth-log'
      );
      fresh.authLogHandler('error', 'INTERNAL_SERVER_ERROR', error);
      fresh.authLogHandler('error', error.message);
    });

    expect(everything(spy.mock.calls)).not.toContain(SENTINEL);
    expect(spy.mock.calls[0][1]).toBe('[DrizzleQueryError: details withheld, no log redactor registered]');
  });
});

describe('installAuthLogRedaction (what apps/auth/app.ts runs at startup)', () => {
  let restore: () => void;
  let consoleSpy: { error: jest.SpyInstance; warn: jest.SpyInstance };

  beforeEach(() => {
    consoleSpy = {
      error: jest.spyOn(console, 'error').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
    };
    restore = installAuthLogRedaction();
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("redacts what better-auth's logger.log writes, keeping the error's class", () => {
    authLogHandler('error', 'INTERNAL_SERVER_ERROR', failedWrite());

    expect(everything(consoleSpy.error.mock.calls)).not.toContain(SENTINEL);
    expect(consoleSpy.error.mock.calls[0][1].constructor.name).toBe('DrizzleQueryError');
  });

  it("redacts what better-call's router and the adapter write straight to the console", () => {
    console.error('# SERVER_ERROR: ', failedWrite());
    console.warn(failedWrite());

    expect(everything([...consoleSpy.error.mock.calls, ...consoleSpy.warn.mock.calls])).not.toContain(SENTINEL);
  });
});

// Behavior cannot reach these: `apps/auth/app.ts` calls `listen()` and the database when imported, and
// better-auth is ESM-only (the router itself is driven in tests/unit/observability/console-redaction.test.ts).
// So the wiring is pinned in the source.
describe('auth app wiring (source pins)', () => {
  const read = (relPath: string) => readFileSync(resolve(__dirname, '../../..', relPath), 'utf8');
  const app = read('apps/auth/app.ts');

  it('installs the log redaction at startup, and routes better-auth logging through the sink', () => {
    expect(app).toContain('installAuthLogRedaction();');
    expect(read('shared/authentication/src/auth.definition.ts')).toContain('logger: { log: authLogHandler }');
  });

  it.each(['PROVISION USER', 'UPDATE IDENTITY', 'STATION SIGNUP', 'COMPLETE ONBOARDING'])(
    'logs the unexpected [%s] error through redactQueryParams',
    (tag) => {
      expect(app).toContain(`console.error('[${tag}] Unexpected error:', redactQueryParams(error));`);
    }
  );
});
