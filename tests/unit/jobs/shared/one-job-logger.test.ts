/**
 * BS#3399, BS#3398: a job calls `createJobLogger` once and every file imports that instance. `log()` is silent
 * until its own instance's `initLogger` runs, so a second instance in another file would drop its lines.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const JOBS_DIR = resolve(__dirname, '../../../../jobs');

// Jobs that keep a `logger.ts`: more than one of their files logs, or their tests import or mock that module.
const MULTI_FILE_JOBS = [
  'album-critic-reviews-etl',
  'album-level-backfill',
  'album-metadata-bio-fill',
  'album-metadata-reask',
  'album-reviews-etl',
  'apple-music-url-backfill',
  'artist-search-alias-consumer',
  'artwork-provenance-remediation',
  'catalog-popularity-freetext-resolve',
  'concerts-artist-lml-resolver',
  'concerts-artist-resolver',
  'concerts-genre-enrichment',
  'concerts-poster-enrichment',
  'concerts-similar-artists-enrichment',
  'flowsheet-april-gap-import',
  'flowsheet-artwork-repair',
  'flowsheet-dj-name-scrub',
  'flowsheet-ghost-row-sweep',
  'flowsheet-metadata-backfill',
  'flowsheet-no-match-recheck',
  'flowsheet-reenrichment',
  'library-artwork-url-backfill',
  'library-identity-consumer',
  'metadata-no-match-digest',
  'rotation-artist-backfill',
  'rotation-lml-identity-backfill',
  'rotation-release-id-backfill',
  'station-signup-review',
  'streaming-columns-drain',
  'streaming-url-remediation',
  'streaming-url-upgrade',
  'triangle-shows-etl',
  'uncovered-release-list',
  'va-apple-music-url-remediation',
  'venue-events-scraper',
];

const SINGLE_FILE_JOBS = [
  'auth-log-prune',
  'digital-archive-bind',
  'flowsheet-etl',
  'flowsheet-linked-reenrichment',
  'library-discogs-unavailable-recheck',
];

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
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'));
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

// BS#3398: every Sentry capture in these jobs goes through the job logger or `getErrorReporter()`.
const BATCH_1_JOBS = [
  'album-critic-reviews-etl',
  'album-level-backfill',
  'album-metadata-bio-fill',
  'album-metadata-reask',
  'album-reviews-etl',
  'apple-music-url-backfill',
  'artist-search-alias-consumer',
  'artwork-provenance-remediation',
  'auth-log-prune',
  'catalog-popularity-freetext-resolve',
  'concerts-artist-lml-resolver',
  'concerts-artist-resolver',
  'flowsheet-no-match-recheck',
];

// BS#3537: this job keeps `Sentry.startSpan` and `Sentry.withMonitor`, which the reporter seam has no method for.
const SAMPLER_JOBS = ['flowsheet-metadata-backfill'];

describe('no direct Sentry captures in the migrated jobs', () => {
  it.each([...BATCH_1_JOBS, ...SAMPLER_JOBS])('%s has no Sentry.capture* or Sentry.addBreadcrumb call', (job) => {
    const offenders = readdirSync(join(JOBS_DIR, job))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /Sentry\.(capture\w+|addBreadcrumb)\(/.test(readFileSync(join(JOBS_DIR, job, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
