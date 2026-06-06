/**
 * Unit tests for HTTP mirror client and field mapping.
 *
 * Tests the tubafrenzy REST API client that replaces raw SQL
 * for addEntry/updateEntry mirror operations.
 */

// Mock fetch globally before any imports
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({ captureMessage: (...args: unknown[]) => mockCaptureMessage(...args) }));

import {
  mirrorCreateEntry,
  mirrorUpdateEntry,
  cacheEntryId,
  getCachedEntryId,
  clearEntryIdMap,
  mapEntryToTubafrenzy,
  mapUpdateToTubafrenzy,
  mirrorCreateShow,
  mirrorSignoffShow,
  cacheShowId,
  getCachedShowId,
  clearShowIdMap,
  mapShowToTubafrenzy,
} from '../../../../apps/backend/middleware/legacy/http.mirror';

beforeEach(() => {
  mockFetch.mockReset();
  mockCaptureMessage.mockReset();
  clearEntryIdMap();
  clearShowIdMap();
});

describe('http.mirror', () => {
  describe('mirrorCreateEntry', () => {
    it('POSTs to the tubafrenzy API with correct headers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 42 }),
      });

      const body = { artistName: 'Autechre', songTitle: 'VI Scose Poise' };
      await mirrorCreateEntry(body);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/playlists/api/flowsheetEntry');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['Authorization']).toMatch(/^Bearer /);
      expect(JSON.parse(options.body)).toEqual(body);
    });

    it('returns the tubafrenzy entry ID on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 99 }),
      });

      const result = await mirrorCreateEntry({ radioHour: 123 });
      expect(result).toBe(99);
    });

    it('returns null when response has no id field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await mirrorCreateEntry({ radioHour: 123 });
      expect(result).toBeNull();
    });

    it('returns null on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"error":"Database error"}'),
      });

      const result = await mirrorCreateEntry({ radioHour: 123 });
      expect(result).toBeNull();
    });

    it('returns null on network error without throwing', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await mirrorCreateEntry({ radioHour: 123 });
      expect(result).toBeNull();
    });
  });

  describe('mirrorUpdateEntry', () => {
    it('PATCHes with the tubafrenzy entry ID in the body', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await mirrorUpdateEntry(42, { songTitle: 'Updated' });

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/playlists/api/flowsheetEntry');
      expect(options.method).toBe('PATCH');
      const parsed = JSON.parse(options.body);
      expect(parsed.id).toBe(42);
      expect(parsed.songTitle).toBe('Updated');
    });

    it('does not throw on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"error":"Entry not found"}'),
      });

      await expect(mirrorUpdateEntry(999, {})).resolves.toBeUndefined();
    });

    it('does not throw on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(mirrorUpdateEntry(42, {})).resolves.toBeUndefined();
    });
  });

  describe('entryIdMap', () => {
    it('stores and retrieves entry IDs by play_order', () => {
      cacheEntryId(5, 42);
      expect(getCachedEntryId(5)).toBe(42);
    });

    it('returns undefined for unknown play_order', () => {
      expect(getCachedEntryId(999)).toBeUndefined();
    });

    it('overwrites existing entries', () => {
      cacheEntryId(5, 42);
      cacheEntryId(5, 99);
      expect(getCachedEntryId(5)).toBe(99);
    });

    it('clearEntryIdMap removes all entries', () => {
      cacheEntryId(1, 10);
      cacheEntryId(2, 20);
      clearEntryIdMap();
      expect(getCachedEntryId(1)).toBeUndefined();
      expect(getCachedEntryId(2)).toBeUndefined();
    });
  });

  describe('mapEntryToTubafrenzy', () => {
    const baseTrack = {
      id: 1,
      show_id: 100,
      album_id: null as number | null,
      rotation_id: null as number | null,
      entry_type: 'track' as const,
      track_title: 'VI Scose Poise',
      album_title: 'Confield',
      artist_name: 'Autechre',
      record_label: 'Warp',
      play_order: 1,
      request_flag: false,
      segue: false,
      message: null as string | null,
      add_time: new Date('2024-02-01T12:34:56Z'),
    };

    it('maps track fields to tubafrenzy JSON', () => {
      const result = mapEntryToTubafrenzy(baseTrack);

      expect(result.artistName).toBe('Autechre');
      expect(result.songTitle).toBe('VI Scose Poise');
      expect(result.releaseTitle).toBe('Confield');
      expect(result.labelName).toBe('Warp');
      expect(result.request).toBe(false);
      expect(result.libraryReleaseID).toBe(0);
      expect(result.rotationReleaseID).toBe(0);
    });

    it('rounds radioHour to hour boundary', () => {
      const result = mapEntryToTubafrenzy(baseTrack);
      const expectedHour = new Date('2024-02-01T12:00:00Z').getTime();
      expect(result.radioHour).toBe(expectedHour);
    });

    it('sets nowPlayingFlag to 0 (dropped)', () => {
      const result = mapEntryToTubafrenzy(baseTrack);
      expect(result.nowPlayingFlag).toBe(0);
    });

    it('does not include radioShowID when not provided', () => {
      const result = mapEntryToTubafrenzy(baseTrack);
      expect(result).not.toHaveProperty('radioShowID');
    });

    it('includes radioShowID when provided', () => {
      const result = mapEntryToTubafrenzy(baseTrack, 171500);
      expect(result.radioShowID).toBe(171500);
    });

    it('does not include radioShowID when null', () => {
      const result = mapEntryToTubafrenzy(baseTrack, null);
      expect(result).not.toHaveProperty('radioShowID');
    });

    it('maps rotation track to flowsheetEntryType 2', () => {
      const entry = { ...baseTrack, rotation_id: 456, album_id: 123 };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(2);
    });

    it('maps library track to flowsheetEntryType 6', () => {
      const entry = { ...baseTrack, album_id: 123 };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(6);
    });

    it('maps unresolved track to flowsheetEntryType 0', () => {
      const result = mapEntryToTubafrenzy(baseTrack);
      expect(result.flowsheetEntryType).toBe(0);
    });

    it('maps request_flag true', () => {
      const entry = { ...baseTrack, request_flag: true };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.request).toBe(true);
    });

    it('maps segue false by default', () => {
      const result = mapEntryToTubafrenzy(baseTrack);
      expect(result.segue).toBe(false);
    });

    it('maps segue true', () => {
      const entry = { ...baseTrack, segue: true };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.segue).toBe(true);
    });

    it('maps show_start to flowsheetEntryType 9', () => {
      const entry = { ...baseTrack, entry_type: 'show_start' as const, message: 'DJ signed on' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(9);
      expect(result.artistName).toBe('DJ signed on');
    });

    it('maps show_end to flowsheetEntryType 10', () => {
      const entry = { ...baseTrack, entry_type: 'show_end' as const, message: 'DJ signed off' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(10);
    });

    it('maps talkset to flowsheetEntryType 7', () => {
      const entry = { ...baseTrack, entry_type: 'talkset' as const, message: 'talking' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
      expect(result.artistName).toBe('------ talkset -------');
    });

    it('maps breakpoint to flowsheetEntryType 8', () => {
      const entry = { ...baseTrack, entry_type: 'breakpoint' as const, message: 'top of hour' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(8);
      expect(result.artistName).toBe('TOP OF HOUR');
    });

    it('maps dj_join to flowsheetEntryType 7', () => {
      const entry = { ...baseTrack, entry_type: 'dj_join' as const, message: 'DJ2 joined' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
    });

    it('maps message to flowsheetEntryType 7', () => {
      const entry = { ...baseTrack, entry_type: 'message' as const, message: 'PSA' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
      expect(result.artistName).toBe('------ talkset -------');
    });

    it('legacy: detects breakpoint from message pattern', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'BREAKPOINT - top of hour',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(8);
      expect(result.artistName).toBe('BREAKPOINT - TOP OF HOUR');
    });

    it('legacy: detects show start from "signed on" message', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'DJ Name signed on at 10:00 AM',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(9);
      expect(result.startTime).toBeGreaterThan(0);
    });

    it('legacy: detects show start from "start of show" message', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'Start of show - Welcome!',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(9);
    });

    it('legacy: detects show end from "signed off" message', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'DJ Name signed off at 12:00 PM',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(10);
      expect(result.startTime).toBeGreaterThan(0);
    });

    it('legacy: detects show end from "end of show" message', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'End of show - thanks for listening',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(10);
    });

    it('legacy: defaults unrecognized message to talkset', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'unknown' as any,
        message: 'Random DJ comment',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
      expect(result.artistName).toBe('------ talkset -------');
    });

    it('breakpoint with empty message defaults to BREAKPOINT', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'breakpoint' as const,
        message: '',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(8);
      expect(result.artistName).toBe('BREAKPOINT');
    });

    it('show_start sets startTime to entry timestamp', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'show_start' as const,
        message: 'DJ signed on',
        add_time: new Date('2024-02-01T12:34:56Z'),
      };
      const result = mapEntryToTubafrenzy(entry);
      const expectedMs = new Date('2024-02-01T12:34:56Z').getTime();
      expect(result.startTime).toBe(expectedMs);
    });

    it('dj_leave maps to flowsheetEntryType 7', () => {
      const entry = { ...baseTrack, entry_type: 'dj_leave' as const, message: 'DJ2 left' };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
    });

    it('non-track entry with message and unknown entry_type uses pattern matching', () => {
      const entry = {
        ...baseTrack,
        entry_type: '' as any,
        message: 'some note',
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
    });

    it('handles null fields gracefully', () => {
      const entry = {
        ...baseTrack,
        artist_name: null,
        track_title: null,
        album_title: null,
        record_label: null,
        request_flag: undefined as any,
        segue: undefined as any,
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.artistName).toBe('');
      expect(result.songTitle).toBe('');
      expect(result.releaseTitle).toBe('');
      expect(result.labelName).toBe('');
      expect(result.request).toBe(false);
      expect(result.segue).toBe(false);
    });

    it('uses Date.now() when add_time is null', () => {
      const before = Date.now();
      const entry = { ...baseTrack, add_time: null };
      const result = mapEntryToTubafrenzy(entry);
      const after = Date.now();
      const radioHour = result.radioHour as number;
      // radioHour should be a valid hour boundary derived from Date.now()
      expect(radioHour).toBeGreaterThanOrEqual(Math.floor(before / 3_600_000) * 3_600_000);
      expect(radioHour).toBeLessThanOrEqual(Math.floor(after / 3_600_000) * 3_600_000);
    });

    it('non-track entry with null message defaults to empty string', () => {
      const entry = {
        ...baseTrack,
        entry_type: 'talkset' as const,
        message: null,
      };
      const result = mapEntryToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(7);
      expect(result.artistName).toBe('------ talkset -------');
    });
  });

  describe('mapUpdateToTubafrenzy', () => {
    const baseTrack = {
      id: 1,
      album_id: null as number | null,
      rotation_id: null as number | null,
      entry_type: 'track' as const,
      track_title: 'Updated Song',
      album_title: 'Updated Album',
      artist_name: 'Updated Artist',
      record_label: 'Updated Label',
      play_order: 5,
      request_flag: true,
      segue: false,
      message: null as string | null,
      add_time: new Date(),
    };

    it('maps all updateable track fields', () => {
      const result = mapUpdateToTubafrenzy(baseTrack);

      expect(result.artistName).toBe('Updated Artist');
      expect(result.songTitle).toBe('Updated Song');
      expect(result.releaseTitle).toBe('Updated Album');
      expect(result.labelName).toBe('Updated Label');
      expect(result.request).toBe(true);
      expect(result.segue).toBe(false);
    });

    it('maps segue true in update', () => {
      const entry = { ...baseTrack, segue: true };
      const result = mapUpdateToTubafrenzy(entry);
      expect(result.segue).toBe(true);
    });

    it('maps library ID to flowsheetEntryType 6', () => {
      const entry = { ...baseTrack, album_id: 123 };
      const result = mapUpdateToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(6);
      expect(result.libraryReleaseID).toBe(123);
    });

    it('maps rotation ID to flowsheetEntryType 2', () => {
      const entry = { ...baseTrack, rotation_id: 456, album_id: 123 };
      const result = mapUpdateToTubafrenzy(entry);
      expect(result.flowsheetEntryType).toBe(2);
      expect(result.rotationReleaseID).toBe(456);
    });

    it('does not include radioShowID or radioHour', () => {
      const result = mapUpdateToTubafrenzy(baseTrack);
      expect(result).not.toHaveProperty('radioShowID');
      expect(result).not.toHaveProperty('radioHour');
    });

    it('handles null fields with defaults', () => {
      const entry = {
        ...baseTrack,
        artist_name: null,
        track_title: null,
        album_title: null,
        record_label: null,
        request_flag: undefined as any,
        segue: undefined as any,
        album_id: null,
        rotation_id: null,
      };
      const result = mapUpdateToTubafrenzy(entry);
      expect(result.artistName).toBe('');
      expect(result.songTitle).toBe('');
      expect(result.releaseTitle).toBe('');
      expect(result.labelName).toBe('');
      expect(result.request).toBe(false);
      expect(result.segue).toBe(false);
      expect(result.libraryReleaseID).toBe(0);
      expect(result.rotationReleaseID).toBe(0);
      expect(result.flowsheetEntryType).toBe(0);
    });
  });

  describe('mirrorCreateShow', () => {
    it('POSTs to the tubafrenzy radioShow API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 171500 }),
      });

      const body = { djName: 'Kate Bailey', djHandle: 'DJ Catalyst', signonTime: 1773792000000 };
      const result = await mirrorCreateShow(body);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/playlists/api/radioShow');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual(body);
      expect(result).toBe(171500);
    });

    it('retries on failure up to 5 times', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('error') })
        .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('error') })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 171500 }) });

      const result = await mirrorCreateShow({ djName: 'Test' });
      expect(result).toBe(171500);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('returns null after all retries fail', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('error'),
      });

      const result = await mirrorCreateShow({ djName: 'Test' });
      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('returns null on network error without throwing', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await mirrorCreateShow({ djName: 'Test' });
      expect(result).toBeNull();
    });
  });

  describe('mirrorSignoffShow', () => {
    it('POSTs to the signoff endpoint', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      await mirrorSignoffShow(171500, 1773799200000);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/playlists/api/radioShow/signoff');
      expect(options.method).toBe('POST');
      const parsed = JSON.parse(options.body);
      expect(parsed.radioShowId).toBe(171500);
      expect(parsed.signoffTime).toBe(1773799200000);
    });

    it('does not throw on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        text: () => Promise.resolve('already signed off'),
      });

      await expect(mirrorSignoffShow(171500, 1773799200000)).resolves.toBeUndefined();
    });

    it('does not throw on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(mirrorSignoffShow(171500, 1773799200000)).resolves.toBeUndefined();
    });
  });

  describe('Sentry reporting on failure', () => {
    it('mirrorCreateEntry captures HTTP error with status tag and truncated body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"Invalid or missing credentials"}'),
      });

      await mirrorCreateEntry({ radioHour: 0 });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'Mirror: create_entry failed',
        expect.objectContaining({
          level: 'error',
          tags: expect.objectContaining({
            subsystem: 'legacy-mirror',
            operation: 'create_entry',
            status: '401',
          }),
          extra: expect.objectContaining({
            status: 401,
            responseBody: expect.stringContaining('Invalid or missing credentials'),
          }),
        })
      );
    });

    it('mirrorCreateEntry captures network error without status tag', async () => {
      const err = new Error('ECONNREFUSED');
      mockFetch.mockRejectedValue(err);

      await mirrorCreateEntry({ radioHour: 0 });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'Mirror: create_entry failed',
        expect.objectContaining({
          level: 'error',
          tags: expect.objectContaining({ subsystem: 'legacy-mirror', operation: 'create_entry' }),
          extra: expect.objectContaining({ error: expect.stringContaining('ECONNREFUSED') }),
        })
      );
      const call = mockCaptureMessage.mock.calls[0][1];
      expect(call.tags).not.toHaveProperty('status');
    });

    it('mirrorUpdateEntry captures HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('not found'),
      });

      await mirrorUpdateEntry(42, { songTitle: 'x' });

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'Mirror: update_entry failed',
        expect.objectContaining({
          tags: expect.objectContaining({ operation: 'update_entry', status: '404' }),
        })
      );
    });

    it('mirrorSignoffShow captures HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        text: () => Promise.resolve('already signed off'),
      });

      await mirrorSignoffShow(171500, 1773799200000);

      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'Mirror: signoff_show failed',
        expect.objectContaining({
          tags: expect.objectContaining({ operation: 'signoff_show', status: '409' }),
        })
      );
    });

    it('truncates large response bodies to 500 chars', async () => {
      const huge = 'x'.repeat(2000);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(huge),
      });

      await mirrorCreateEntry({ radioHour: 0 });

      const call = mockCaptureMessage.mock.calls[0][1];
      expect(call.extra.responseBody.length).toBe(500);
    });

    it('mirrorCreateEntry does not capture on success', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 1 }) });

      await mirrorCreateEntry({ radioHour: 0 });

      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });
  });

  describe('showIdMap', () => {
    it('stores and retrieves show IDs by backend show ID', () => {
      cacheShowId(100, 171500);
      expect(getCachedShowId(100)).toBe(171500);
    });

    it('returns undefined for unknown backend show ID', () => {
      expect(getCachedShowId(999)).toBeUndefined();
    });

    it('overwrites existing entries', () => {
      cacheShowId(100, 171500);
      cacheShowId(100, 171501);
      expect(getCachedShowId(100)).toBe(171501);
    });

    it('clearShowIdMap removes all entries', () => {
      cacheShowId(100, 171500);
      cacheShowId(101, 171501);
      clearShowIdMap();
      expect(getCachedShowId(100)).toBeUndefined();
      expect(getCachedShowId(101)).toBeUndefined();
    });
  });

  describe('mapShowToTubafrenzy', () => {
    it('maps show and DJ to tubafrenzy JSON', () => {
      const show = {
        id: 100,
        show_name: 'Friday Night Jazz',
        specialty_id: 5,
        start_time: new Date('2024-02-01T12:00:00Z'),
      };
      const dj = {
        realName: 'Kate Bailey',
        djName: 'DJ Catalyst',
        name: 'kate',
      };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djName).toBe('Kate Bailey');
      expect(result.djHandle).toBe('DJ Catalyst');
      expect(result.showName).toBe('Friday Night Jazz');
      expect(result.specialtyShowId).toBe(5);
      expect(result.signonTime).toBe(new Date('2024-02-01T12:00:00Z').getTime());
    });

    it('falls back to name when realName/djName are null', () => {
      const show = { id: 100, start_time: new Date() };
      const dj = { realName: null, djName: null, name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djName).toBe('kate');
      expect(result.djHandle).toBe('kate');
    });

    it('defaults optional fields', () => {
      const show = { id: 100, start_time: new Date() };
      const dj = { name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.showName).toBe('');
      expect(result.specialtyShowId).toBe(0);
      expect(result.djId).toBe(0);
    });

    // BS#1321: tubafrenzy mirror reflects the per-show display-name override
    // on the `djHandle` field so the legacy tubafrenzy admin UI + on-air
    // playlist surfaces match Backend-Service's flowsheet rows. Override
    // does NOT touch `djName` (tubafrenzy's distinct real-name field).
    it('uses dj_name_override on djHandle when present (BS#1321)', () => {
      const show = {
        id: 100,
        show_name: 'Friday Night Jazz',
        specialty_id: 5,
        start_time: new Date('2024-02-01T12:00:00Z'),
        dj_name_override: 'Guest Host Aubrey',
      };
      const dj = { realName: 'Kate Bailey', djName: 'DJ Catalyst', name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djHandle).toBe('Guest Host Aubrey');
      // djName tracks "the human behind the mic" — it stays unchanged.
      expect(result.djName).toBe('Kate Bailey');
    });

    it('trims whitespace from dj_name_override (BS#1321)', () => {
      const show = {
        id: 100,
        start_time: new Date(),
        dj_name_override: '  Aubrey Hearst  ',
      };
      const dj = { realName: 'Kate Bailey', djName: 'DJ Catalyst', name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djHandle).toBe('Aubrey Hearst');
    });

    it('falls back to dj.djName when dj_name_override is null (BS#1321)', () => {
      const show = {
        id: 100,
        start_time: new Date(),
        dj_name_override: null,
      };
      const dj = { realName: 'Kate Bailey', djName: 'DJ Catalyst', name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djHandle).toBe('DJ Catalyst');
    });

    it('falls back to dj.djName when dj_name_override is whitespace-only (BS#1321)', () => {
      const show = {
        id: 100,
        start_time: new Date(),
        dj_name_override: '   ',
      };
      const dj = { realName: 'Kate Bailey', djName: 'DJ Catalyst', name: 'kate' };

      const result = mapShowToTubafrenzy(show, dj);

      expect(result.djHandle).toBe('DJ Catalyst');
    });
  });
});
