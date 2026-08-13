/**
 * Unit tests for jobs/flowsheet-april-gap-import/build-row.ts's pure
 * LegacyEntryRow -> flowsheet insert-row mapper.
 */
import { buildInsertRow } from '../../../../jobs/flowsheet-april-gap-import/build-row';
import type { LegacyEntryRow } from '../../../../jobs/flowsheet-etl/fetch-legacy';

const makeEntry = (overrides: Partial<LegacyEntryRow> = {}): LegacyEntryRow => ({
  id: 2001,
  showId: 1001,
  entryTypeCode: 0,
  artistName: 'Chuquimamani-Condori',
  albumTitle: 'Edits',
  trackTitle: 'Call Your Name',
  label: 'self-released',
  requestFlag: 0,
  playOrder: 5,
  startTime: 0,
  timeCreated: 1776283200000,
  timeLastModified: 1776283260000,
  legacyReleaseId: 4242,
  radioHour: null,
  segueFlag: 0,
  ...overrides,
});

describe('buildInsertRow', () => {
  it('maps a track entry, applying the START_TIME=0 -> TIME_CREATED fallback (#351)', () => {
    const row = buildInsertRow(makeEntry(), { showId: 10, djName: 'DJ Aubrey Hearst', albumId: 555 });

    expect(row).toEqual(
      expect.objectContaining({
        legacy_entry_id: 2001,
        legacy_release_id: 4242,
        show_id: 10,
        entry_type: 'track',
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
        record_label: 'self-released',
        message: null,
        request_flag: false,
        segue: false,
        play_order: 5,
        radio_hour: null,
        dj_name: 'DJ Aubrey Hearst',
        album_id: 555,
      })
    );
    expect(row?.add_time.getTime()).toBe(1776283200000);
  });

  it('routes talkset/breakpoint text to message, leaving artist_name null (BS#1287)', () => {
    const row = buildInsertRow(makeEntry({ entryTypeCode: 7, artistName: 'TALKSET' }), {
      showId: 10,
      djName: null,
      albumId: null,
    });

    expect(row?.entry_type).toBe('talkset');
    expect(row?.artist_name).toBeNull();
    expect(row?.message).toBe('TALKSET');
  });

  it('preserves a show_start marker artist_name verbatim', () => {
    const marker = 'START OF SHOW: DJ Aubrey Hearst SIGNED ON at 7:43 PM (4/16/26)';
    const row = buildInsertRow(makeEntry({ entryTypeCode: 9, artistName: marker, startTime: 1776283200000 }), {
      showId: 10,
      djName: null,
      albumId: null,
    });

    expect(row?.entry_type).toBe('show_start');
    expect(row?.artist_name).toBe(marker);
    expect(row?.message).toBeNull();
  });

  it('truncates album_title/track_title/record_label to 128 chars at the call site', () => {
    const long = 'A'.repeat(200);
    const row = buildInsertRow(makeEntry({ albumTitle: long, trackTitle: long, label: long }), {
      showId: 10,
      djName: null,
      albumId: null,
    });

    expect(row?.album_title).toHaveLength(128);
    expect(row?.track_title).toHaveLength(128);
    expect(row?.record_label).toHaveLength(128);
  });

  it('maps request_flag / segue from the 1/0 legacy flags', () => {
    const row = buildInsertRow(makeEntry({ requestFlag: 1, segueFlag: 1 }), {
      showId: 10,
      djName: null,
      albumId: null,
    });

    expect(row?.request_flag).toBe(true);
    expect(row?.segue).toBe(true);
  });

  it('carries legacy_release_id straight through (the null sentinel is inherited from fetch-legacy)', () => {
    const row = buildInsertRow(makeEntry({ legacyReleaseId: null }), { showId: 10, djName: null, albumId: null });

    expect(row?.legacy_release_id).toBeNull();
  });

  it('resolves radio_hour only for breakpoint entries', () => {
    const breakpointRow = buildInsertRow(
      makeEntry({ entryTypeCode: 8, artistName: '--- 3:00 PM ---', radioHour: 1776286800000 }),
      { showId: 10, djName: null, albumId: null }
    );
    expect(breakpointRow?.radio_hour?.getTime()).toBe(1776286800000);

    const trackRow = buildInsertRow(makeEntry({ radioHour: 1776286800000 }), {
      showId: 10,
      djName: null,
      albumId: null,
    });
    expect(trackRow?.radio_hour).toBeNull();
  });

  it('carries play_order verbatim (per-show, no unique constraint)', () => {
    const row = buildInsertRow(makeEntry({ playOrder: 42 }), { showId: 10, djName: null, albumId: null });
    expect(row?.play_order).toBe(42);
  });

  it('returns null when no timestamp can be resolved (defensive; should not occur for a windowed candidate)', () => {
    const row = buildInsertRow(makeEntry({ startTime: 0, timeCreated: 0, timeLastModified: 0 }), {
      showId: 10,
      djName: null,
      albumId: null,
    });
    expect(row).toBeNull();
  });

  it('carries a null albumId through to album_id (unlinked; the linkage cron picks it up later)', () => {
    const row = buildInsertRow(makeEntry(), { showId: 10, djName: null, albumId: null });
    expect(row?.album_id).toBeNull();
  });
});
