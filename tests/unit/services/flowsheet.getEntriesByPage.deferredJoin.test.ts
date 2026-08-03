// Regression guard for BS#1960: deep OFFSET pagination on the joined query
// made Postgres compute the 3-LEFT-JOIN row for every discarded offset row,
// 500ing past ~450-500 rows deep (5s statement_timeout). The fix resolves
// the page of flowsheet.id's FIRST (a bare PK-index OFFSET/LIMIT, no joins),
// then joins only that already-bounded page. This test pins the query SHAPE
// so a future edit can't quietly reintroduce OFFSET/LIMIT on the joined
// query — it does not exercise a real planner, so it can't catch a cost
// regression by itself; that needs an EXPLAIN against prod-shaped data.

import { jest } from '@jest/globals';
import { db, flowsheet, rotation, library, album_metadata } from '@wxyc/database';
import { desc, eq } from 'drizzle-orm';
import { getEntriesByPage } from '../../../apps/backend/services/flowsheet.service';

describe('flowsheet.service', () => {
  describe('getEntriesByPage deferred-join shape (BS#1960)', () => {
    // Sentinel standing in for whatever `.as('page')` returns from the real
    // query builder. Its `id` property is what the outer query's innerJoin
    // predicate must reference (`eq(flowsheet.id, page.id)`) — using a
    // distinct sentinel value (not the same string as `flowsheet.id`) makes
    // a bug that joins against the wrong column visible as a failed toEqual
    // rather than an accidental pass.
    const pageSubquery = { id: 'page.id-sentinel' };

    // Inner (subquery) chain: select({id}) -> from(flowsheet) ->
    // orderBy(desc(id)) -> offset(n) -> limit(m) -> as('page').
    const asMock = jest.fn().mockReturnValue(pageSubquery);
    const subLimitMock = jest.fn().mockReturnValue({ as: asMock });
    const subOffsetMock = jest.fn().mockReturnValue({ limit: subLimitMock });
    const subOrderByMock = jest.fn().mockReturnValue({ offset: subOffsetMock });
    const subFromMock = jest.fn().mockReturnValue({ orderBy: subOrderByMock });

    // Outer chain: select(FSEntryFieldsRaw) -> from(page) ->
    // innerJoin(flowsheet) -> leftJoin(rotation) -> leftJoin(library) ->
    // leftJoin(album_metadata) -> orderBy(desc(id)).
    const outerOrderByMock = jest.fn().mockResolvedValue([]);
    const leftJoin3Mock = jest.fn().mockReturnValue({ orderBy: outerOrderByMock });
    const leftJoin2Mock = jest.fn().mockReturnValue({ leftJoin: leftJoin3Mock });
    const leftJoin1Mock = jest.fn().mockReturnValue({ leftJoin: leftJoin2Mock });
    const innerJoinMock = jest.fn().mockReturnValue({ leftJoin: leftJoin1Mock });
    const outerFromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });

    const selectMock = jest
      .fn()
      .mockReturnValueOnce({ from: subFromMock })
      .mockReturnValueOnce({ from: outerFromMock });

    beforeEach(() => {
      asMock.mockClear();
      subLimitMock.mockClear();
      subOffsetMock.mockClear();
      subOrderByMock.mockClear();
      subFromMock.mockClear();
      outerOrderByMock.mockClear();
      outerOrderByMock.mockResolvedValue([]);
      leftJoin3Mock.mockClear();
      leftJoin2Mock.mockClear();
      leftJoin1Mock.mockClear();
      innerJoinMock.mockClear();
      outerFromMock.mockClear();

      asMock.mockReturnValue(pageSubquery);
      subLimitMock.mockReturnValue({ as: asMock });
      subOffsetMock.mockReturnValue({ limit: subLimitMock });
      subOrderByMock.mockReturnValue({ offset: subOffsetMock });
      subFromMock.mockReturnValue({ orderBy: subOrderByMock });
      leftJoin3Mock.mockReturnValue({ orderBy: outerOrderByMock });
      leftJoin2Mock.mockReturnValue({ leftJoin: leftJoin3Mock });
      leftJoin1Mock.mockReturnValue({ leftJoin: leftJoin2Mock });
      innerJoinMock.mockReturnValue({ leftJoin: leftJoin1Mock });
      outerFromMock.mockReturnValue({ innerJoin: innerJoinMock });

      selectMock.mockReset();
      selectMock.mockReturnValueOnce({ from: subFromMock }).mockReturnValueOnce({ from: outerFromMock });
      (db as unknown as { select: jest.Mock }).select = selectMock;
    });

    it('applies offset/limit to the bare id subquery, not the joined query', async () => {
      await getEntriesByPage(5000, 100);

      // The subquery is built from the bare flowsheet table (no joins) and
      // carries the offset/limit — this is the load-bearing fix: pre-#1960
      // these landed on the fully-joined query instead.
      expect(subFromMock).toHaveBeenCalledWith(flowsheet);
      expect(subOrderByMock).toHaveBeenCalledWith(desc(flowsheet.id));
      expect(subOffsetMock).toHaveBeenCalledWith(5000);
      expect(subLimitMock).toHaveBeenCalledWith(100);
      expect(asMock).toHaveBeenCalledWith('page');
    });

    it('joins the bounded id-page against flowsheet, then rotation/library/album_metadata', async () => {
      await getEntriesByPage(5000, 100);

      expect(outerFromMock).toHaveBeenCalledWith(pageSubquery);
      expect(innerJoinMock).toHaveBeenCalledWith(flowsheet, eq(flowsheet.id, pageSubquery.id));
      expect(leftJoin1Mock).toHaveBeenCalledWith(rotation, eq(rotation.id, flowsheet.rotation_id));
      expect(leftJoin2Mock).toHaveBeenCalledWith(library, eq(library.id, flowsheet.album_id));
      expect(leftJoin3Mock).toHaveBeenCalledWith(album_metadata, eq(album_metadata.album_id, flowsheet.album_id));
    });

    it('re-establishes descending order on the outer query after the join', async () => {
      await getEntriesByPage(5000, 100);

      expect(outerOrderByMock).toHaveBeenCalledWith(desc(flowsheet.id));
      // Never desc(play_order) — flowsheet.id is globally monotonic and
      // unique, unlike play_order (see getEntriesByShow's tie-break).
      expect(outerOrderByMock).not.toHaveBeenCalledWith(desc(flowsheet.play_order));
    });

    it('applies the transform to each raw row returned by the outer query', async () => {
      const rawRow = {
        id: 42,
        show_id: 1,
        album_id: null,
        entry_type: 'track',
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
        track_position: 'A1',
        record_label: 'self-released',
        label_id: null,
        rotation_id: null,
        rotation_bin: null,
        artist_id: null,
        request_flag: false,
        segue: false,
        message: null,
        play_order: 1,
        legacy_entry_id: null,
        legacy_release_id: null,
        add_time: new Date('2026-01-01T00:00:00Z'),
        dj_name: 'DJ Test',
        linkage_source: null,
        linkage_confidence: null,
        linked_at: null,
        artwork_url: null,
        discogs_url: null,
        release_year: null,
        spotify_url: null,
        apple_music_url: null,
        youtube_music_url: null,
        bandcamp_url: null,
        soundcloud_url: null,
        artist_bio: null,
        artist_wikipedia_url: null,
        genres: null,
        styles: null,
        on_streaming: null,
        discogs_unavailable: null,
        discogs_unavailable_note: null,
        metadata_status: 'enriched_no_match',
        enriching_since: null,
        radio_hour: null,
      };
      outerOrderByMock.mockResolvedValue([rawRow]);

      const result = await getEntriesByPage(5000, 100);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 42, artist_name: 'Chuquimamani-Condori', track_title: 'Call Your Name' });
    });
  });
});
