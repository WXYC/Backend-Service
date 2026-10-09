/**
 * better-auth's log sink (`logger.log`), with a redaction seam.
 *
 * better-auth logs the raw error it caught, and a failed Drizzle query's
 * message quotes every bound value, `auth_user.real_name` included (BS#3054).
 * This package cannot depend on `@wxyc/observability` (it builds first), so the
 * auth app registers that package's `redactLogValue` at startup with
 * `setAuthLogRedactor`. Until it does, values pass through unchanged.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Redactor = (value: unknown) => unknown;

let redact: Redactor = (value) => value;

/** Register the function every better-auth log message and argument passes through. */
export function setAuthLogRedactor(redactor: Redactor): void {
  redact = redactor;
}

/** better-auth's `logger.log`: the default console output, with redacted message and arguments. */
export function authLogHandler(level: LogLevel, message: string, ...args: unknown[]): void {
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  write(`${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${redact(message)}`, ...args.map(redact));
}
