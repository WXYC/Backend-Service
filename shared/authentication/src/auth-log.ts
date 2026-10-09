/**
 * better-auth's log sink (`logger.log`), with a redaction seam.
 *
 * better-auth logs the raw error it caught, and a failed Drizzle query's
 * message quotes every bound value, `auth_user.real_name` included (BS#3054).
 * This package cannot depend on `@wxyc/observability` (it builds first), so the
 * auth app registers that package's `redactLogValue` at startup with
 * `setAuthLogRedactor`. Until it does, the sink fails closed: an error is
 * logged as its class name and a fixed placeholder, never its message or the
 * error object, and a string is cut at the `\nparams: ` marker that Drizzle's
 * message puts before the bound values. That covers every process that builds
 * the `auth` singleton without running `apps/auth/app.ts` (the backend, jobs,
 * scripts).
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Redactor = (value: unknown) => unknown;

const PARAMS_MARKER = '\nparams: ';
const WITHHELD = 'details withheld, no log redactor registered';

/** The redactor used until the app registers one: withholds errors, cuts strings at the params marker. */
function failClosedRedactor(value: unknown): unknown {
  if (typeof value === 'string') {
    const at = value.indexOf(PARAMS_MARKER);
    return at === -1 ? value : `${value.slice(0, at)}${PARAMS_MARKER}[redacted]`;
  }
  if (value instanceof Error) {
    return `[${Object.getPrototypeOf(value)?.constructor?.name ?? 'Error'}: ${WITHHELD}]`;
  }
  return value;
}

let redact: Redactor = failClosedRedactor;

/** Register the function every better-auth log message and argument passes through. */
export function setAuthLogRedactor(redactor: Redactor): void {
  redact = redactor;
}

/** Restore the fail-closed default. For tests. */
export function resetAuthLogRedactor(): void {
  redact = failClosedRedactor;
}

/** better-auth's `logger.log`: the default console output, with redacted message and arguments. */
export function authLogHandler(level: LogLevel, message: string, ...args: unknown[]): void {
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  write(`${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${redact(message)}`, ...args.map(redact));
}
