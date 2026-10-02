/**
 * The BS#2776 scaffold ships a buildable image for a job that does not exist
 * yet. `deploy-base.yml` discovers Docker targets from the workspace graph, so
 * from the moment this package merges an operator can `docker run` it. The one
 * behaviour worth pinning in this slice is therefore that running it is loud
 * and non-zero rather than a silent exit 0 that reads as "drained, nothing to
 * do".
 *
 * Replaced by the real `job.test.ts` in BS#2777.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { main } from '../../../../jobs/album-metadata-bio-fill/job';

describe('album-metadata-bio-fill scaffold', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('exits non-zero instead of pretending to have run', async () => {
    await main();

    expect(process.exitCode).toBe(1);
  });
});
