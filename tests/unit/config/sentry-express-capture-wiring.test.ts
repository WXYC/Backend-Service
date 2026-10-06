import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// What each preload passes to `Sentry.init` on Sentry 11 (BS#2947, BS#2948).
// `dotenv` and the sample-rate resolver are stubbed so the outcome does not
// depend on the local `.env`.
const mockInit = jest.fn();
const mockExpressIntegration = jest.fn((options: unknown) => ({ name: 'Express', options }));
jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  expressIntegration: (options: unknown) => mockExpressIntegration(options),
}));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../apps/backend/sentry-config', () => ({ resolveTracesSampleRate: () => 1 }));
jest.mock('../../../apps/auth/sentry-config', () => ({ resolveTracesSampleRate: () => 1 }));

interface InitOptions {
  integrations?: unknown[];
  traceLifecycle?: string;
}

async function initOptionsOf(modulePath: string): Promise<InitOptions> {
  await jest.isolateModulesAsync(async () => {
    await import(modulePath);
  });
  expect(mockInit).toHaveBeenCalledTimes(1);
  return (mockInit.mock.calls[0] as [InitOptions])[0];
}

describe.each([
  ['backend', '../../../apps/backend/instrument'],
  ['auth', '../../../apps/auth/instrument'],
])('%s instrument.ts', (_app, modulePath) => {
  // Sentry 11's default Express integration captures at the layer that threw,
  // before app error middleware runs, and ignores our predicates. The terminal
  // `sentryExpressErrorCapture` must stay the only Express capture path.
  it('disables the Express integration auto-capture', async () => {
    const options = await initOptionsOf(modulePath);

    expect(mockExpressIntegration).toHaveBeenCalledWith({ shouldHandleError: false });
    expect(options.integrations).toContainEqual({ name: 'Express', options: { shouldHandleError: false } });
  });

  // Sentry 11 defaults to span streaming, under which no transaction event is
  // built and `beforeSendTransaction` (the BS#2089/BS#2406 filter) never runs.
  it('pins the static trace lifecycle so beforeSendTransaction runs', async () => {
    const options = await initOptionsOf(modulePath);

    expect(options.traceLifecycle).toBe('static');
  });
});

// The worker has no Express and no transaction filter, but it ran on the
// transaction lifecycle under Sentry 10 like its siblings (BS#2948).
it('enrichment-worker instrument.ts pins the static trace lifecycle', async () => {
  const options = await initOptionsOf('../../../apps/enrichment-worker/instrument');

  expect(options.traceLifecycle).toBe('static');
});

describe.each([
  ['backend', '../../../apps/backend/app.ts', 'shouldCaptureExpressError', 'errorHandler'],
  ['auth', '../../../apps/auth/app.ts', 'shouldCaptureAuthExpressError', 'fallbackErrorHandler'],
])('%s app.ts', (_app, relPath, predicate, terminalHandler) => {
  const source = readFileSync(resolve(__dirname, relPath), 'utf-8');

  // Booting app.ts would start the whole service, so the position is pinned
  // on source; the middleware's behavior in a real pipeline is covered by
  // tests/unit/observability/express-error-capture.test.ts.
  it(`captures via ${predicate} immediately before ${terminalHandler}`, () => {
    const wiring = new RegExp(
      String.raw`app\.use\(\s*sentryExpressErrorCapture\(\{\s*shouldCapture:\s*${predicate},\s*captureException:\s*Sentry\.captureException\s*\}\)\s*\);\s*(?://[^\n]*\n\s*)*app\.use\(${terminalHandler}\);`
    );
    expect(source).toMatch(wiring);
  });

  it('no longer calls the deprecated setupExpressErrorHandler', () => {
    expect(source).not.toMatch(/setupExpressErrorHandler\(/);
  });
});
