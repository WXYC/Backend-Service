/**
 * The BS#3140 scaffold ships a buildable image for a job that does not exist
 * yet. `deploy-base.yml` discovers Docker targets from the workspace graph, so
 * from the moment this package merges an operator can `docker run` it. The one
 * behaviour worth pinning in this slice is therefore that running it is loud
 * and non-zero rather than a silent exit 0 that reads as "re-asked, nothing to
 * do".
 *
 * Replaced by the real `job.test.ts` when the options and dry run land.
 *
 * @see WXYC/Backend-Service#3137
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
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
    const lines = stderr.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', step: 'not_implemented', tool: 'album-metadata-reask' })
    );
  });
});
