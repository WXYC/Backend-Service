/**
 * Unit tests for artwork-provenance-remediation `orchestrate.ts` (BS#2258).
 *
 * Pins:
 *   1. The enumeration SELECT narrows to Discogs-hosted artwork in SQL and
 *      leaves the provenance decision to the tested decoder — a `LIKE`
 *      cannot decide it, and a SQL base64 decode would be a second,
 *      untested implementation of the same rule.
 *   2. `selectWrongProvenance` is a POSITIVE match on artist/label. Release
 *      covers and Apple `mzstatic` URLs are dropped, so the 191 legitimate
 *      Apple rows can never enter the drain.
 *   3. `runRemediation` calls `lookup` once per selected row, dispatches to
 *      the writer, and accumulates the per-outcome counters BS#2258's
 *      acceptance criteria ask to be reported.
 *   4. An LML throw is counted as `error` and the writer is NOT invoked;
 *      the row keeps its wrong artwork so a re-run retries it.
 *   5. Cooperative pause defers to live flowsheet activity.
 */
import { jest } from '@jest/globals';

import { db, type CheckLiveActivityFn } from '@wxyc/database';
import {
  enumerateDiscogsArtwork,
  runRemediation,
  selectWrongProvenance,
  type LookupFn,
  type RemediateFn,
} from '../../../../jobs/artwork-provenance-remediation/orchestrate';
import type { WrongArtworkRow } from '../../../../jobs/artwork-provenance-remediation/remediate';
import type { LookupResponse } from '@wxyc/lml-client';
import { renderSql } from '../../../utils/render-sql';

const LABEL_LOGO =
  'https://i.discogs.com/JuO51-lZvasOtw8-yLUjsen-4O17uPH1A9SILCO-lG4/rs:fit/g:sm/q:90/h:300/w:299/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9MLTE4NjYt/MTIzMzE5MzU1Ny5q/cGVn.jpeg';
const ARTIST_IMAGE =
  'https://i.discogs.com/Lj7_VfsOG9ZjqxZAxm0VEjQSQHvbG-wy-Zj9KRaEIgo/rs:fit/g:sm/q:90/h:606/w:600/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9BLTMyNjgt/MTY2Mzg3MTI0OS0z/MzY1LmpwZWc.jpeg';
const RELEASE_COVER =
  'https://i.discogs.com/FnUJPxhECqKDvFoT-z2-GT9g5uRYLE8rjIetCX4lsMs/rs:fit/g:sm/q:90/h:600/w:593/czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9SLTEzNzEy/OS0xMjIyODc4OTE5/LmpwZWc.jpeg';
const APPLE_ARTWORK =
  'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b6/05/21/b605217c-42ee-8c1e-238b-0fc18570b10d/196873025063.jpg/600x600bb.jpg';

const mockDb = db as unknown as { transaction: jest.Mock; execute: jest.Mock };

const row = (album_id: number, artwork_url: string, album_title = 'Chiastic Slide'): WrongArtworkRow => ({
  album_id,
  artist_name: 'Autechre',
  album_title,
  artwork_url,
});

const healedResponse = { results: [{ artwork: { artwork_url: RELEASE_COVER } }] } as unknown as LookupResponse;

describe('enumerateDiscogsArtwork', () => {
  it('narrows to Discogs-hosted artwork and joins library for the lookup keys', async () => {
    const executed: unknown[] = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: (arg: unknown) => {
          executed.push(arg);
          return Promise.resolve([]);
        },
      })
    );

    await enumerateDiscogsArtwork();

    const select = executed.map(renderSql).find((s) => s.includes('SELECT'));
    expect(select).toBeDefined();
    expect(select).toContain('i.discogs.com');
    expect(select).toContain('"artwork_url" IS NOT NULL');
    expect(select).toContain('"wxyc_schema"."album_metadata" am');
    // The join key, pinned because it is easy to get wrong: `album_metadata`
    // has no `library_id` — it keys on `album_id`, which IS `library.id`.
    expect(select).toContain('"wxyc_schema"."library" l ON l."id" = am."album_id"');
    expect(select).toContain('COALESCE(a."artist_name", l."artist_name")');
  });

  it('sets a statement_timeout before the scan', async () => {
    const executed: unknown[] = [];
    mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: (arg: unknown) => {
          executed.push(arg);
          return Promise.resolve([]);
        },
      })
    );

    await enumerateDiscogsArtwork(90_000);

    expect(renderSql(executed[0])).toContain("SET LOCAL statement_timeout = '90000ms'");
  });
});

describe('selectWrongProvenance', () => {
  it('keeps only rows whose artwork provably depicts something other than the release', () => {
    const selected = selectWrongProvenance([
      row(1, LABEL_LOGO),
      row(2, RELEASE_COVER),
      row(3, ARTIST_IMAGE),
      row(4, APPLE_ARTWORK),
    ]);

    expect(selected.map((r) => r.album_id)).toEqual([1, 3]);
  });

  it('never selects a legitimate Apple cover, even though it decodes to nothing', () => {
    expect(selectWrongProvenance([row(4, APPLE_ARTWORK)])).toEqual([]);
  });
});

describe('runRemediation', () => {
  const healed = () => jest.fn<RemediateFn>().mockResolvedValue('healed');
  const quiet = () => jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);

  it('looks up each selected row once and counts the writer outcomes', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(healedResponse);
    const remediate = healed();

    const { totals } = await runRemediation({
      lookup,
      remediate,
      rows: [row(1, LABEL_LOGO), row(2, ARTIST_IMAGE)],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(remediate).toHaveBeenCalledTimes(2);
    expect(totals).toMatchObject({ scanned: 2, healed: 2, still_wrong: 0, no_match: 0, raced: 0, error: 0 });
  });

  it('looks the album up by (artist, album) — there is no track context here', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(healedResponse);

    await runRemediation({
      lookup,
      remediate: healed(),
      rows: [row(7, LABEL_LOGO, 'Confield')],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(lookup).toHaveBeenCalledWith('Autechre', 'Confield');
  });

  it('splits the selected population by provenance before it spends any updated_at', async () => {
    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(healedResponse),
      remediate: healed(),
      rows: [row(1, LABEL_LOGO), row(2, ARTIST_IMAGE), row(3, LABEL_LOGO)],
      discogsArtworkRows: 41_333,
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ discogs_artwork_rows: 41_333, label_logo: 2, artist_image: 1 });
  });

  it.each<['still_wrong' | 'no_match' | 'raced']>([['still_wrong'], ['no_match'], ['raced']])(
    'accumulates the %s outcome into its own counter',
    async (outcome) => {
      const { totals } = await runRemediation({
        lookup: jest.fn<LookupFn>().mockResolvedValue(healedResponse),
        remediate: jest.fn<RemediateFn>().mockResolvedValue(outcome),
        rows: [row(1, LABEL_LOGO)],
        liveActivityLookbackSeconds: 0,
        checkLiveActivity: quiet(),
      });

      expect(totals[outcome]).toBe(1);
      expect(totals.healed).toBe(0);
    }
  );

  it('counts an LML throw as `error` and never calls the writer for that row', async () => {
    const remediate = healed();

    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockRejectedValue(new Error('LML exploded')),
      remediate,
      rows: [row(1, LABEL_LOGO)],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ scanned: 1, error: 1 });
    expect(remediate).not.toHaveBeenCalled();
  });

  it('keeps going after one row errors, so a transient blip costs one row not the run', async () => {
    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(healedResponse),
      remediate: healed(),
      rows: [row(1, LABEL_LOGO), row(2, ARTIST_IMAGE)],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ scanned: 2, error: 1, healed: 1 });
  });

  it('defers to live flowsheet activity before each row', async () => {
    const probe = jest.fn<CheckLiveActivityFn>().mockResolvedValueOnce(true).mockResolvedValue(false);

    await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(healedResponse),
      remediate: healed(),
      rows: [row(1, LABEL_LOGO)],
      liveActivityLookbackSeconds: 60,
      liveActivityPauseMs: 1,
      checkLiveActivity: probe,
    });

    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });
});
