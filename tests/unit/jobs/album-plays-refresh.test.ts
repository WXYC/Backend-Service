/**
 * Unit tests for the album-plays-refresh job.
 *
 * The job runs `REFRESH MATERIALIZED VIEW CONCURRENTLY wxyc_schema.album_plays`
 * on a schedule (see jobs/album-plays-refresh/package.json) and records the
 * run in cronjob_runs. Database is mocked so no SQL actually executes.
 */

const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockUpdateLastRun = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock('@wxyc/database', () => ({
  db: { execute: mockExecute },
  updateLastRun: mockUpdateLastRun,
  closeDatabaseConnection: mockClose,
}));

jest.mock('drizzle-orm', () => ({
  // The job builds the REFRESH statement via `sql\`...\`` with no
  // interpolations. The mock just joins the static template parts so the
  // test can assert on the final string sent to db.execute.
  sql: (strings: TemplateStringsArray) => ({ raw: strings.join('') }),
}));

import { JOB_NAME, refreshAlbumPlays } from '../../../jobs/album-plays-refresh/job';

describe('album-plays-refresh job', () => {
  beforeEach(() => {
    mockExecute.mockClear();
    mockUpdateLastRun.mockClear();
  });

  it('exposes a stable JOB_NAME used as the cronjob_runs primary key', () => {
    // The cron job tracking row is keyed by job_name, so renaming this
    // would orphan the existing last_run record. Pinned in a test so any
    // future rename has to come through deliberately.
    expect(JOB_NAME).toBe('album-plays-refresh');
  });

  it('refreshes the materialized view concurrently', async () => {
    await refreshAlbumPlays();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const arg = mockExecute.mock.calls[0][0] as { raw: string };
    expect(arg.raw).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\s+"wxyc_schema"\."album_plays"/i);
  });

  it('records last_run after a successful refresh', async () => {
    await refreshAlbumPlays();
    expect(mockUpdateLastRun).toHaveBeenCalledTimes(1);
    const [jobName, timestamp] = mockUpdateLastRun.mock.calls[0];
    expect(jobName).toBe('album-plays-refresh');
    expect(timestamp).toBeInstanceOf(Date);
  });

  it('does not record last_run when the refresh fails', async () => {
    mockExecute.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshAlbumPlays()).rejects.toThrow('boom');
    expect(mockUpdateLastRun).not.toHaveBeenCalled();
  });
});
