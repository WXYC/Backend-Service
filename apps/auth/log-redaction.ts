/**
 * Keeps failed-query bound parameters (legal names since BS#3051) out of the auth
 * process's logs (BS#3054). better-auth logs the raw error it caught through two
 * paths: its `logger.log` sink, and better-call's `console.error('# SERVER_ERROR: ', error)`
 * for any non-APIError, which better-auth 1.6 gives no setting to silence without
 * changing the response a client gets. Both go through the redactor here.
 */
import { resetAuthLogRedactor, setAuthLogRedactor } from '@wxyc/authentication';
import { installConsoleRedaction, redactLogValue } from '@wxyc/observability';

/** Call once at startup, before the first request. Returns a function that undoes it (for tests). */
export function installAuthLogRedaction(): () => void {
  setAuthLogRedactor(redactLogValue);
  const restoreConsole = installConsoleRedaction();
  return () => {
    restoreConsole();
    resetAuthLogRedactor();
  };
}
