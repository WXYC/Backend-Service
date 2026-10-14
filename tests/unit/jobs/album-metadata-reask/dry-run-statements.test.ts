/**
 * The dry run's zero-writes guarantee, checked on the real statements. Unlike
 * `dry-run.test.ts`, `cohort` is NOT mocked here: every statement the dry run
 * sends through the `@wxyc/database` double is rendered with `renderSql` (the
 * unit tier mocks drizzle) and must be a read (`WITH ... SELECT`) or the read timeout.
 *
 * @see WXYC/Backend-Service#3144
 */

import { describe, it, expect, jest, afterAll, beforeEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderSql } from '../../../utils/render-sql';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));

import { db } from '@wxyc/database';
import { bulkLookupMetadata } from '@wxyc/lml-client';
import { resolveOptions, runReask } from '../../../../jobs/album-metadata-reask/job';

const dir = mkdtempSync(join(tmpdir(), 'reask-statements-'));
const file = (name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n'));
  return path;
};
const env = {
  REASK_PIN_FILE: file('pins.csv', [
    'library_id,discogs_release_id,source,updated_at',
    '1001,5001,alex-l-2026,2026-10-14 09:53:12-07',
  ]),
  REASK_REMOVED_FILE: file('removed.csv', ['library_id,discogs_release_id,source']),
  REASK_GRADES_FILE: file('grades.csv', [
    'library_id,stored_release_id,pin_release_id,pin_source,stored_title_score,pin_title_score,stored_play_rate,pin_play_rate,excluded_other_plays,excluded_inferred_plays,tier,expected_release_id',
    '1001,4001,5001,alex-l-2026,40,95,0.1,0.8,0,0,rebind,',
  ]),
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  (db.execute as unknown as jest.Mock).mockResolvedValue([] as never);
});

describe('runReask dry run, real cohort statements', () => {
  it('sends only reads and the read timeout, and never calls LML', async () => {
    await runReask(resolveOptions(env, []));

    const statements = (db.execute as unknown as jest.Mock).mock.calls.map(([statement]) =>
      renderSql(statement).trim()
    );
    // Two reads (count, enumerate), each behind its own SET LOCAL.
    expect(statements).toHaveLength(4);
    for (const text of statements) {
      expect(text).toMatch(/^(SET LOCAL statement_timeout = '\d+ms'|WITH pin AS \()/);
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });
});
