/**
 * `--preview` writes nothing (BS#3150), checked on the real statements. As in `dry-run-statements.test.ts`, `cohort`
 * is NOT mocked: every statement the preview sends through the `@wxyc/database` double is rendered with `renderSql`
 * and must be a read or the read timeout, even when LML answers with a writing verdict (`rebind`, `clear`). The sample
 * is the same for the same seed.
 *
 * @see WXYC/Backend-Service#3150
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
import { bulkLookupMetadata as bulkLookupMetadataImport, type BulkLookupItem } from '@wxyc/lml-client';
import * as logger from '../../../../jobs/album-metadata-reask/logger';
import { resolveMode, runPreview, type ReaskOptions } from '../../../../jobs/album-metadata-reask/job';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;
const execute = db.execute as unknown as jest.Mock;

const dir = mkdtempSync(join(tmpdir(), 'reask-preview-'));
const file = (name: string, lines: string[]): string => {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n'));
  return path;
};
const env = {
  REASK_PIN_FILE: file('pins.csv', [
    'library_id,discogs_release_id,source,updated_at',
    '1001,5001,alex-l-2026-masters-api,2026-10-14 09:53:12-07',
    '1002,5002,alex-l-2026,2026-10-14 09:53:12-07',
  ]),
  REASK_REMOVED_FILE: file('removed.csv', [
    'library_id,discogs_release_id,source',
    '1003,4003,alex-l-2026-masters-api',
  ]),
  REASK_GRADES_FILE: file('grades.csv', [
    'library_id,stored_release_id,pin_release_id,pin_source,stored_title_score,pin_title_score,stored_play_rate,pin_play_rate,excluded_other_plays,excluded_inferred_plays,tier,expected_release_id',
    '1001,4001,5001,alex-l-2026-masters-api,40,95,0.1,0.8,0,0,rebind,',
    '1002,4002,5002,alex-l-2026,80,90,,,3,0,hold_ungradeable,',
    '1003,4003,4003,alex-l-2026-masters-api,70,,,,0,0,hold_ungradeable,',
  ]),
  REASK_SAMPLE_SEED: '20261014',
  REASK_BULK_RATE_PER_MIN: '600000',
};

// Juana Molina, Jessica Pratt and Stereolab from the WXYC example set: two pin mismatches and one removed pin.
const COHORT = [
  [1, 1001, 4001, 5001, 'alex-l-2026-masters-api', 'Juana Molina', 'DOGA'],
  [2, 1002, 4002, 5002, 'alex-l-2026', 'Jessica Pratt', 'On Your Own Love Again'],
  [3, 1003, 4003, null, 'alex-l-2026-masters-api', 'Stereolab', 'Dots and Loops'],
].map(([album_id, legacy_release_id, stored, pin, pin_source, artist_name, album_title]) => ({
  album_id,
  legacy_release_id,
  discogs_url: `https://www.discogs.com/release/${stored}`,
  artwork_url: `https://i.discogs.com/${stored}.jpg`,
  library_artwork_url: `https://i.discogs.com/${stored}.jpg`,
  stored_release_id: stored,
  artist_name,
  album_title,
  reason: pin === null ? 'pin_removed' : 'pin_mismatch',
  pin_release_id: pin,
  pin_source,
  restored: false,
}));
const CARD: Record<string, number> = { 'Juana Molina': 1001, 'Jessica Pratt': 1002 };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockImplementation((statement: unknown) => {
    const text = renderSql(statement);
    if (text.includes('SELECT c.album_id')) {
      return Promise.resolve(COHORT);
    }
    if (text.trim().startsWith('SELECT am.*')) {
      return Promise.resolve(
        COHORT.map((c) => ({ album_id: c.album_id, discogs_url: c.discogs_url, artwork_url: c.artwork_url }))
      );
    }
    return Promise.resolve([]);
  });
  // Each pinned card answers with its pin (`rebind`); the removed tier-2a card finds nothing (`clear`).
  bulkLookupMetadata.mockImplementation((items: BulkLookupItem[]) =>
    Promise.resolve({
      results: items.map((item, index) => {
        const card = CARD[item.artist ?? ''];
        if (card === undefined) {
          return { index, status: 'no_match', lookup: null };
        }
        const release = card + 4000;
        return {
          index,
          status: 'match',
          lookup: {
            search_type: 'direct',
            results: [
              {
                library_item: { id: card },
                artwork: {
                  release_id: release,
                  album: item.album,
                  release_url: `https://www.discogs.com/release/${release}`,
                  artwork_url: `https://i.discogs.com/${release}.jpg`,
                },
              },
            ],
          },
        };
      }),
    })
  );
});

const preview = async (extra: Record<string, string> = {}) => {
  const log = jest.spyOn(logger, 'log');
  const mode = resolveMode({ ...env, ...extra }, ['node', 'job.js', '--preview']);
  const summary = await runPreview(mode.options as ReaskOptions);
  const lines = log.mock.calls.filter(([, step]) => step === 'preview').map(([, , , fields]) => fields);
  log.mockRestore();
  return { summary, lines };
};

describe('runPreview, real statements', () => {
  it('asks LML for the sample and sends only reads and the read timeout, even for writing verdicts', async () => {
    const { summary, lines } = await preview({ REASK_MAX_ALBUMS: '3' });

    expect(lines.map((line) => [line?.album_id, line?.verdict])).toEqual([
      [1, 'rebind'],
      [2, 'rebind'],
      [3, 'clear'],
    ]);
    expect(summary.totals).toEqual({ rebind: 2, clear: 1 });
    expect(bulkLookupMetadata).toHaveBeenCalledTimes(1);
    const statements = execute.mock.calls.map(([statement]) => renderSql(statement as never).trim());
    expect(statements.length).toBeGreaterThan(0);
    for (const text of statements) {
      expect(text).toMatch(/^(SET LOCAL statement_timeout = '\d+ms'|WITH pin AS \(|SELECT am\.\*)/);
      expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    }
  });

  it.each([
    ['the same seed draws the same sample', '20261014', true],
    ['another seed may draw another', '7', false],
  ])('%s', async (_label, seed, same) => {
    const first = await preview({ REASK_MAX_ALBUMS: '1' });
    const second = await preview({ REASK_MAX_ALBUMS: '1', REASK_SAMPLE_SEED: seed });

    expect(first.lines).toHaveLength(1);
    expect(second.lines[0]?.album_id === first.lines[0]?.album_id).toBe(same);
  });
});
