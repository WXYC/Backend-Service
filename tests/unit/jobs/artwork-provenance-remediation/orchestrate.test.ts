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
  summarizePopulation,
  titlesAgree,
  type LookupFn,
  type RemediateFn,
} from '../../../../jobs/artwork-provenance-remediation/orchestrate';
import type { WrongArtworkRow } from '../../../../jobs/artwork-provenance-remediation/remediate';
import { LmlAuthError, type LookupResponse } from '@wxyc/lml-client';
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

describe('runRemediation — failure modes that would otherwise burn a six-hour run', () => {
  const quiet = () => jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
  const healed = () => jest.fn<RemediateFn>().mockResolvedValue('healed');

  /**
   * A rejected bearer is global, not per-row. Counting it as `error` and
   * continuing paces the whole 7,950-row population through at 20/min, emits
   * one Sentry event per row with no aggregate signal, and exits 0 — the
   * silent-stall shape BS#1094 exists to close. Abort on the first one.
   */
  it('aborts the whole run when LML rejects the shared bearer, instead of grinding', async () => {
    const remediate = healed();

    await expect(
      runRemediation({
        lookup: jest.fn<LookupFn>().mockRejectedValue(new LmlAuthError('LML responded with 403', 403)),
        remediate,
        rows: [row(1, LABEL_LOGO), row(2, ARTIST_IMAGE)],
        liveActivityLookbackSeconds: 0,
        checkLiveActivity: quiet(),
      })
    ).rejects.toBeInstanceOf(LmlAuthError);

    expect(remediate).not.toHaveBeenCalled();
  });

  /**
   * A write error is per-row, not global: the row keeps its wrong artwork and
   * re-selects next run. Letting it escape would discard the run's accounting,
   * which is what BS#2258's acceptance criteria actually ask to be reported.
   */
  it('counts a write failure as `error` and keeps going', async () => {
    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(healedResponse),
      remediate: jest.fn<RemediateFn>().mockRejectedValueOnce(new Error('lock timeout')).mockResolvedValue('healed'),
      rows: [row(1, LABEL_LOGO), row(2, ARTIST_IMAGE)],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ scanned: 2, error: 1, healed: 1 });
  });

  /**
   * The safety property — an Apple cover or a release cover can never enter
   * the drain — has to hold at the boundary that writes, not at one call site
   * in `job.ts`. `rows` is a public entry point.
   */
  it('re-applies the positive-match selector to caller-supplied rows', async () => {
    const remediate = healed();

    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(healedResponse),
      remediate,
      rows: [row(1, LABEL_LOGO), row(2, RELEASE_COVER), row(3, APPLE_ARTWORK)],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(remediate).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ scanned: 1, label_logo: 1, artist_image: 0 });
  });
});

describe('summarizePopulation', () => {
  it('reports the pre-drain split, so a dry run can be reconciled against the ticket', () => {
    expect(summarizePopulation([row(1, LABEL_LOGO), row(2, ARTIST_IMAGE), row(3, LABEL_LOGO)])).toEqual({
      artist_image: 1,
      label_logo: 2,
    });
  });

  it('counts nothing for rows the selector would have dropped', () => {
    expect(summarizePopulation([row(1, RELEASE_COVER), row(2, APPLE_ARTWORK)])).toEqual({
      artist_image: 0,
      label_logo: 0,
    });
  });
});

/**
 * BS#2258 measurement, not a gate. A 240-row stratified read-only probe on
 * 2026-08-25 found 238/240 exact title agreement, one same-album format
 * variant ("Pork Soda" vs "Pork Soda + 2 [10-inch single]"), and zero
 * wrong-album bindings — so the drain does NOT refuse on divergence. It
 * counts, so the same question is answered at 7,950 rows instead of 240, and
 * so a regression in LML's matching surfaces as a number rather than as
 * quietly-wrong covers.
 */
describe('titlesAgree', () => {
  it.each([
    ['identical titles', 'Confield', 'Confield', true],
    ['case and spacing', 'girl in the half pearl', 'Girl In The Half Pearl', true],
    ['a trailing space', 'A Sentimental Christmas', 'A Sentimental Christmas ', true],
    ['a straight apostrophe', "Amnesiac's Blues", 'Amnesiacs Blues', true],
    ['a curly apostrophe', 'Amnesiac\u2019s Blues', 'Amnesiacs Blues', true],
    ['a hyphen against a space', 'Post-Punk Kitchen', 'Post Punk Kitchen', true],
    ['diacritics', 'Pequena Vertigem de Amor', 'Pequeña Vertigem de Amor', true],
    ['a genuinely different album', 'Confield', 'Aluminum Tunes', false],
    ['a format-annotated variant', 'Pork Soda', 'Pork Soda + 2 [10-inch single]', false],
    ['a missing Discogs title', 'Confield', undefined, false],
    ['an empty Discogs title', 'Confield', '', false],
  ])('%s', (_label, libraryTitle, discogsTitle, expected) => {
    expect(titlesAgree(libraryTitle, discogsTitle)).toBe(expected);
  });
});

describe('runRemediation — title agreement is counted, never enforced', () => {
  const quiet = () => jest.fn<CheckLiveActivityFn>().mockResolvedValue(false);
  const withTitle = (album: string | undefined) =>
    ({ results: [{ artwork: { album, artwork_url: RELEASE_COVER } }] }) as unknown as LookupResponse;

  it('counts an exact title match', async () => {
    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(withTitle('Confield')),
      remediate: jest.fn<RemediateFn>().mockResolvedValue('healed'),
      rows: [row(1, LABEL_LOGO, 'Confield')],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ healed: 1, title_agreed: 1, title_diverged: 0 });
  });

  it('counts a divergence but still writes — the probe says divergence means a different pressing, not a different album', async () => {
    const remediate = jest.fn<RemediateFn>().mockResolvedValue('healed');

    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockResolvedValue(withTitle('Something Else Entirely')),
      remediate,
      rows: [row(1, LABEL_LOGO, 'Confield')],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(remediate).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ healed: 1, title_agreed: 0, title_diverged: 1 });
  });

  it('does not count a title comparison for a row that never got an answer', async () => {
    const { totals } = await runRemediation({
      lookup: jest.fn<LookupFn>().mockRejectedValue(new Error('boom')),
      remediate: jest.fn<RemediateFn>().mockResolvedValue('healed'),
      rows: [row(1, LABEL_LOGO, 'Confield')],
      liveActivityLookbackSeconds: 0,
      checkLiveActivity: quiet(),
    });

    expect(totals).toMatchObject({ error: 1, title_agreed: 0, title_diverged: 0 });
  });
});
