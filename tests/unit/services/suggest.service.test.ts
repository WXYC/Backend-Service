// Use the real drizzle-orm `sql` tag (the unit suite auto-mocks it) so the
// service builds a real SQL object we can compile with PgDialect and inspect
// the escaped ILIKE patterns + ESCAPE clause. The mock @wxyc/database tables
// are plain string maps, which the real `sql` tag binds as params — fine here.
jest.unmock('drizzle-orm');

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../mocks/database.mock';

const dialect = new PgDialect();

/** Extract the compiled SQL text + bound params for the Nth db.execute call. */
const compiledExecuteCall = (n = 0) => {
  const stmt = (db.execute as jest.Mock).mock.calls[n][0];
  return dialect.sqlToQuery(stmt);
};

beforeEach(() => {
  jest.clearAllMocks();
});

import { suggestArtists, suggestTracks, getTrackDetails } from '../../../apps/backend/services/suggest.service';

describe('suggest.service', () => {
  describe('suggestArtists', () => {
    it('returns matching artist names ordered by plays', async () => {
      const mockRows = [{ artist_name: 'Autechre' }, { artist_name: 'Autolux' }];
      (db.execute as jest.Mock).mockResolvedValue(mockRows);

      const result = await suggestArtists('Aut');

      expect(result).toEqual(['Autechre', 'Autolux']);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no matches', async () => {
      (db.execute as jest.Mock).mockResolvedValue([]);

      const result = await suggestArtists('zzz');

      expect(result).toEqual([]);
    });

    it('respects limit parameter', async () => {
      const mockRows = [{ artist_name: 'Autechre' }];
      (db.execute as jest.Mock).mockResolvedValue(mockRows);

      const result = await suggestArtists('Aut', 1);

      expect(result).toEqual(['Autechre']);
    });

    it('treats a % in the prefix literally (escapes wildcards, adds ESCAPE)', async () => {
      (db.execute as jest.Mock).mockResolvedValue([]);

      await suggestArtists('A%');

      const { sql: text, params } = compiledExecuteCall();
      // Prefix "A%" -> escaped "A\%" -> pattern "A\%%" (only the trailing % is a wildcard).
      expect(params).toContain('A\\%%');
      expect(text).toContain("ESCAPE '\\'");
    });

    it('treats a _ in the prefix literally', async () => {
      (db.execute as jest.Mock).mockResolvedValue([]);

      await suggestArtists('Hot_');

      const { params } = compiledExecuteCall();
      expect(params).toContain('Hot\\_%');
    });
  });

  describe('suggestTracks', () => {
    it('returns matching tracks from flowsheet with album and label', async () => {
      const mockFlowsheetRows = [{ track_title: 'VI Scose Poise', album_title: 'Confield', record_label: 'Warp' }];
      (db.execute as jest.Mock).mockResolvedValue(mockFlowsheetRows);

      const result = await suggestTracks('VI', 'Autechre');

      expect(result).toEqual([{ track_title: 'VI Scose Poise', album_title: 'Confield', record_label: 'Warp' }]);
    });

    it('returns empty array when no matches', async () => {
      (db.execute as jest.Mock).mockResolvedValue([]);

      const result = await suggestTracks('zzz', 'Autechre');

      expect(result).toEqual([]);
    });

    it('merges compilation track results when flowsheet has fewer than limit', async () => {
      const mockFlowsheetRows = [{ track_title: 'VI Scose Poise', album_title: 'Confield', record_label: 'Warp' }];
      const mockCtaRows = [{ track_title: 'Vose In', album_title: 'We Are Reasonable People', record_label: 'Warp' }];
      (db.execute as jest.Mock).mockResolvedValueOnce(mockFlowsheetRows).mockResolvedValueOnce(mockCtaRows);

      const result = await suggestTracks('V', 'Autechre', 5);

      expect(result).toHaveLength(2);
      expect(result[0].track_title).toBe('VI Scose Poise');
      expect(result[1].track_title).toBe('Vose In');
    });

    it('deduplicates compilation results against flowsheet results', async () => {
      const mockFlowsheetRows = [{ track_title: 'VI Scose Poise', album_title: 'Confield', record_label: 'Warp' }];
      const mockCtaRows = [{ track_title: 'VI Scose Poise', album_title: 'Some Compilation', record_label: 'Warp' }];
      (db.execute as jest.Mock).mockResolvedValueOnce(mockFlowsheetRows).mockResolvedValueOnce(mockCtaRows);

      const result = await suggestTracks('VI', 'Autechre', 5);

      expect(result).toHaveLength(1);
      expect(result[0].album_title).toBe('Confield');
    });

    it('escapes wildcards in both the track prefix and the artist name', async () => {
      (db.execute as jest.Mock).mockResolvedValue([]);

      await suggestTracks('%', 'AC_DC');

      const { sql: text, params } = compiledExecuteCall();
      // Prefix "%" must not become a bare wildcard that ignores the LIMIT contract.
      expect(params).toContain('\\%%');
      // Artist name is a full-value (exact) ILIKE: escaped, no added wildcards.
      expect(params).toContain('AC\\_DC');
      expect(text).toContain("ESCAPE '\\'");
    });

    it('skips compilation query when flowsheet results meet limit', async () => {
      const mockFlowsheetRows = Array.from({ length: 5 }, (_, i) => ({
        track_title: `Track ${i}`,
        album_title: `Album ${i}`,
        record_label: 'Warp',
      }));
      (db.execute as jest.Mock).mockResolvedValue(mockFlowsheetRows);

      const result = await suggestTracks('T', 'Autechre', 5);

      expect(result).toHaveLength(5);
      expect(db.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTrackDetails', () => {
    it('returns album and label from flowsheet', async () => {
      const mockRows = [{ album_title: 'Confield', record_label: 'Warp' }];
      (db.execute as jest.Mock).mockResolvedValue(mockRows);

      const result = await getTrackDetails('Autechre', 'VI Scose Poise');

      expect(result).toEqual({ album_title: 'Confield', record_label: 'Warp' });
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('falls back to library when flowsheet has no results', async () => {
      const mockLibraryRows = [{ album_title: 'Confield', record_label: 'Warp' }];
      (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce(mockLibraryRows);

      const result = await getTrackDetails('Autechre', 'VI Scose Poise');

      expect(result).toEqual({ album_title: 'Confield', record_label: 'Warp' });
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('falls back to library when flowsheet has null album and label', async () => {
      const mockLibraryRows = [{ album_title: 'Confield', record_label: 'Warp' }];
      (db.execute as jest.Mock)
        .mockResolvedValueOnce([{ album_title: null, record_label: null }])
        .mockResolvedValueOnce(mockLibraryRows);

      const result = await getTrackDetails('Autechre', 'VI Scose Poise');

      expect(result).toEqual({ album_title: 'Confield', record_label: 'Warp' });
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('returns null when no match in flowsheet or library', async () => {
      (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await getTrackDetails('Unknown Artist', 'Unknown Track');

      expect(result).toBeNull();
    });

    it('escapes wildcards in the artist name and track title (full-value ILIKE)', async () => {
      (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await getTrackDetails('AC_DC', '100%');

      const flowsheet = compiledExecuteCall(0);
      expect(flowsheet.params).toContain('AC\\_DC');
      expect(flowsheet.params).toContain('100\\%');
      expect(flowsheet.sql).toContain("ESCAPE '\\'");

      // Library fallback also escapes the artist name.
      const library = compiledExecuteCall(1);
      expect(library.params).toContain('AC\\_DC');
      expect(library.sql).toContain("ESCAPE '\\'");
    });
  });
});
