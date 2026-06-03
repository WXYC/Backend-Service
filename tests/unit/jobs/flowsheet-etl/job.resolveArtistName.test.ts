/**
 * Unit tests for resolveArtistName.
 *
 * Regression cover for #1287: the flowsheet ETL must preserve the verbatim
 * ARTIST_NAME text that tubafrenzy holds for show_start / show_end markers
 * (e.g. "START OF SHOW: DJ Aubrey Hearst SIGNED ON at 7:43 PM (6/2/26)")
 * rather than reducing it to the bare DJ name.
 *
 * Marker text shape is owned by the writer (see epic #1288). This ETL stays
 * shape-agnostic: whatever marker text TF holds is what BS persists, up to
 * the 128-char artist_name column limit.
 */

// Mock fetch-legacy so importing job.ts doesn't try to open a MirrorSQL
// connection during module evaluation.
jest.mock('../../../../jobs/flowsheet-etl/fetch-legacy', () => ({
  fetchLegacyShows: jest.fn(),
  fetchLegacyEntries: jest.fn(),
  closeLegacyConnection: jest.fn(),
}));

import { resolveArtistName } from '../../../../jobs/flowsheet-etl/job';

describe('resolveArtistName', () => {
  describe('show_start / show_end markers — verbatim', () => {
    it('preserves a START OF SHOW marker verbatim', () => {
      const marker = 'START OF SHOW: DJ Aubrey Hearst SIGNED ON at 7:43 PM (6/2/26)';
      expect(resolveArtistName(marker, 'show_start')).toBe(marker);
    });

    it('preserves an END OF SHOW marker verbatim', () => {
      const marker = 'END OF SHOW: Aubrey Hearst SIGNED OFF at 7:43 PM (6/2/26)';
      expect(resolveArtistName(marker, 'show_end')).toBe(marker);
    });

    it('preserves a mixed-case BS-mirror marker verbatim', () => {
      // BS writer-side template (post-#1286) emits "Start of Show: <name> joined the set at <time>".
      // The ETL must persist whatever shape TF mirrors back.
      const marker = 'Start of Show: Aubrey Hearst joined the set at 7:11 PM';
      expect(resolveArtistName(marker, 'show_start')).toBe(marker);
    });

    it('truncates a marker longer than 128 chars', () => {
      const long = 'START OF SHOW: ' + 'A'.repeat(200) + ' SIGNED ON at 7:43 PM (6/2/26)';
      const result = resolveArtistName(long, 'show_start');
      expect(result).toHaveLength(128);
      expect(result?.startsWith('START OF SHOW: ')).toBe(true);
    });
  });

  describe('null guards', () => {
    it('returns null for null input (show_start)', () => {
      expect(resolveArtistName(null, 'show_start')).toBeNull();
    });

    it('returns null for null input (show_end)', () => {
      expect(resolveArtistName(null, 'show_end')).toBeNull();
    });

    it('returns null for null input (track)', () => {
      expect(resolveArtistName(null, 'track')).toBeNull();
    });
  });

  describe('track entries — unchanged behavior', () => {
    it('returns a plain artist name truncated to 128', () => {
      expect(resolveArtistName('Stereolab', 'track')).toBe('Stereolab');
    });

    it('truncates an overlong track artist_name to 128', () => {
      const long = 'A'.repeat(200);
      expect(resolveArtistName(long, 'track')).toHaveLength(128);
    });
  });

  describe('message-bearing types — NULL (routed to message column)', () => {
    it('returns null for breakpoint (text routed to message)', () => {
      expect(resolveArtistName('--- 7:00 PM BREAKPOINT ---', 'breakpoint')).toBeNull();
    });

    it('returns null for talkset (text routed to message)', () => {
      expect(resolveArtistName('TALKSET', 'talkset')).toBeNull();
    });

    it('returns null for message (text routed to message)', () => {
      expect(resolveArtistName('PSA: pledge drive starts Monday', 'message')).toBeNull();
    });
  });
});
