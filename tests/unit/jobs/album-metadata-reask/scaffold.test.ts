// Pins the scaffold's loud non-zero exit (see job.ts); replaced by job.test.ts when the options land (BS#3137).

import { describe, it, expect, afterEach, jest } from '@jest/globals';

// Keep the real Sentry client (and its global hooks) out of the jest worker,
// as the other job tests do.
jest.mock('@sentry/node', () => ({
  __esModule: true,
  init: jest.fn(),
  captureException: jest.fn(),
  setTag: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { main } from '../../../../jobs/album-metadata-reask/job';

describe('album-metadata-reask scaffold', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it('logs not_implemented to stderr and exits non-zero instead of pretending to have run', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main();

    expect(process.exitCode).toBe(1);
    // Parse only the job's JSON lines, so an unrelated stderr warning cannot fail the test.
    const lines = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.trimStart().startsWith('{'))
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', step: 'not_implemented', tool: 'album-metadata-reask' })
    );
  });
});
