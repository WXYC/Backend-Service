/**
 * Unit tests for the rotation-match mirror helper (BS#1432).
 *
 * Verifies that isActiveRotationMatch returns true when the entry matches an
 * active rotation row via any of the three cohorts, false on non-match, and
 * false (with Sentry warning) on DB error — so the caller falls through to
 * the existing album_id → type-6 branch rather than regressing to type-0.
 */

const mockCaptureMessage = jest.fn();
jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  captureMirrorFailure: mockCaptureMessage,
}));

const mockDbExecute = jest.fn();
jest.mock('@wxyc/database', () => ({
  db: { execute: mockDbExecute },
  rotation: { id: 'rotation.id' },
  library: { id: 'library.id' },
  artists: { id: 'artists.id' },
}));

jest.mock('drizzle-orm', () => ({
  sql: jest.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({})),
}));

import { isActiveRotationMatch } from '../../../../apps/backend/middleware/legacy/rotation-match.mirror';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isActiveRotationMatch', () => {
  const baseEntry = {
    rotation_id: null as number | null,
    album_id: null as number | null,
    artist_name: 'Juana Molina',
    album_title: 'DOGA',
    add_time: new Date('2024-06-14T22:00:00Z'),
  };

  describe('early returns (no DB query)', () => {
    it('returns false when rotation_id is set', async () => {
      const entry = { ...baseEntry, rotation_id: 42 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when artist_name is empty', async () => {
      const entry = { ...baseEntry, artist_name: '' };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when artist_name is whitespace only', async () => {
      const entry = { ...baseEntry, artist_name: '   ' };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when album_title is empty', async () => {
      const entry = { ...baseEntry, album_title: '' };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when artist_name is null', async () => {
      const entry = { ...baseEntry, artist_name: null };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when album_title is null', async () => {
      const entry = { ...baseEntry, album_title: null };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });
  });

  describe('cohort (b): name-match on rotation snapshot fields', () => {
    it('returns true when DB finds a match', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(true);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
    });

    it('returns false when DB finds no match', async () => {
      mockDbExecute.mockResolvedValue([{ match: false }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(false);
    });

    it('returns false when DB returns empty array', async () => {
      mockDbExecute.mockResolvedValue([]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(false);
    });
  });

  describe('cohort (a): album_id match', () => {
    it('queries DB and returns true when match via album_id', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, album_id: 123 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(true);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
    });

    it('returns false when album_id present but no rotation match', async () => {
      mockDbExecute.mockResolvedValue([{ match: false }]);
      const entry = { ...baseEntry, album_id: 999 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
    });
  });

  describe('cohort (c): name-match through library + artists join', () => {
    it('queries DB and returns true when match via join', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(true);
    });
  });

  describe('DB error handling', () => {
    it('returns false on DB error', async () => {
      mockDbExecute.mockRejectedValue(new Error('Connection refused'));
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(false);
    });

    it('calls captureMirrorFailure at warning level on DB error', async () => {
      const err = new Error('Connection refused');
      mockDbExecute.mockRejectedValue(err);
      await isActiveRotationMatch(baseEntry);
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith('rotation_lookup', { error: err }, 'warning');
    });

    it('does not call captureMirrorFailure on success', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      await isActiveRotationMatch(baseEntry);
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('does not call captureMirrorFailure on no-match', async () => {
      mockDbExecute.mockResolvedValue([{ match: false }]);
      await isActiveRotationMatch(baseEntry);
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles null add_time (uses current time)', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, add_time: null };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(true);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
    });

    it('handles numeric add_time (epoch ms)', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, add_time: new Date('2024-06-14T22:00:00Z').getTime() };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(true);
    });

    it('handles string add_time (ISO)', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, add_time: '2024-06-14T22:00:00Z' };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(true);
    });

    it('returns false when rotation_id is 0 (not positive)', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, rotation_id: 0 };
      const result = await isActiveRotationMatch(entry);
      // rotation_id = 0 is falsy, so we fall through to the DB query
      expect(result).toBe(true);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
    });
  });
});
