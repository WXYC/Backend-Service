import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Sentry 11's default `expressIntegration` captures at the layer that threw,
// before any app error middleware runs, and ignores our predicates. Both
// preloads must switch that capture off so the terminal
// `sentryExpressErrorCapture` middleware stays the only Express capture path
// (BS#2947).
const mockInit = jest.fn();
const mockExpressIntegration = jest.fn((options: unknown) => ({ name: 'Express', options }));
jest.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => mockInit(...args),
  expressIntegration: (options: unknown) => mockExpressIntegration(options),
}));

describe.each([
  ['backend', '../../../apps/backend/instrument'],
  ['auth', '../../../apps/auth/instrument'],
])('%s instrument.ts', (_app, modulePath) => {
  it('disables the Express integration auto-capture', async () => {
    await jest.isolateModulesAsync(async () => {
      await import(modulePath);
    });

    expect(mockExpressIntegration).toHaveBeenCalledWith({ shouldHandleError: false });
    const [options] = mockInit.mock.calls[0] as [{ integrations?: unknown[] }];
    expect(options.integrations).toContainEqual({ name: 'Express', options: { shouldHandleError: false } });
  });
});

describe.each([
  ['backend', '../../../apps/backend/app.ts', 'shouldCaptureExpressError', 'errorHandler'],
  ['auth', '../../../apps/auth/app.ts', 'shouldCaptureAuthExpressError', 'fallbackErrorHandler'],
])('%s app.ts', (_app, relPath, predicate, terminalHandler) => {
  const source = readFileSync(resolve(__dirname, relPath), 'utf-8');

  it(`captures via ${predicate} immediately before ${terminalHandler}`, () => {
    const wiring = new RegExp(
      String.raw`app\.use\(sentryExpressErrorCapture\(${predicate}\)\);\s*(?://[^\n]*\n\s*)*app\.use\(${terminalHandler}\);`
    );
    expect(source).toMatch(wiring);
  });

  it('no longer calls the deprecated setupExpressErrorHandler', () => {
    expect(source).not.toMatch(/setupExpressErrorHandler\(/);
  });
});
