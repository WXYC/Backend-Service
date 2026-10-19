/**
 * BS#3399: a job calls `createJobLogger` once and every file imports that instance. `log()` is silent
 * until its own instance's `initLogger` runs, so a second instance in another file would drop its lines.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const JOBS_DIR = resolve(__dirname, '../../../../jobs');

// Jobs that keep a `logger.ts` because more than one of their files logs.
const MULTI_FILE_JOBS = [
  'concerts-genre-enrichment',
  'concerts-poster-enrichment',
  'concerts-similar-artists-enrichment',
  'flowsheet-april-gap-import',
  'flowsheet-artwork-repair',
  'flowsheet-dj-name-scrub',
  'flowsheet-ghost-row-sweep',
  'flowsheet-reenrichment',
  'library-artwork-url-backfill',
];

const SINGLE_FILE_JOBS = ['digital-archive-bind', 'flowsheet-etl', 'flowsheet-linked-reenrichment'];

const filesCallingCreateJobLogger = (job: string): string[] =>
  readdirSync(join(JOBS_DIR, job))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => readFileSync(join(JOBS_DIR, job, f), 'utf8').includes('createJobLogger('));

describe('one createJobLogger instance per job', () => {
  it.each(MULTI_FILE_JOBS)('%s creates its logger in logger.ts only', (job) => {
    expect(filesCallingCreateJobLogger(job)).toEqual(['logger.ts']);
  });

  it.each(SINGLE_FILE_JOBS)('%s creates its logger in job.ts only', (job) => {
    expect(filesCallingCreateJobLogger(job)).toEqual(['job.ts']);
  });

  it.each(MULTI_FILE_JOBS)('%s: log() from a file other than the entrypoint writes after initLogger', async (job) => {
    const { initLogger, log, closeLogger } = await import(`../../../../jobs/${job}/logger`);
    const writes: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      log('info', 'before-init', 'dropped');
      initLogger({ repo: 'Backend-Service', tool: job });
      log('info', 'after-init', 'kept');
    } finally {
      spy.mockRestore();
      await closeLogger();
    }

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ step: 'after-init', message: 'kept', tool: job });
  });
});
