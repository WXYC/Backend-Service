/**
 * Unit tests for the rotation-match mirror helper (BS#1432).
 *
 * Verifies that isActiveRotationMatch returns true when the entry matches an
 * active rotation row via any of the three cohorts, false on non-match, and
 * false (with Sentry warning) on DB error — so the caller falls through to
 * the existing album_id → type-6 branch rather than regressing to type-0.
 *
 * SQL parity reference: the cohort SQL inside the helper is a near-verbatim
 * write-path counterpart of the read-path COALESCE subquery in
 * `apps/backend/services/flowsheet.service.ts`'s `FSEntryFieldsRaw.rotation_bin`
 * (BS#1362). That subquery has direct integration coverage in
 * `tests/integration/flowsheet.spec.js:801+` ("rotation_bin read-path
 * fallback (dj-site#750)") which seeds rotation rows and exercises all three
 * cohorts (album_id, denorm snapshot, library+artists join) + kill_date
 * filter + the negative no-match case against a real Postgres. The helper's
 * WHERE clause is identical to that subquery's WHERE clause; if the read-
 * path tests pass, the helper's SQL parses and the predicates select the
 * same rows. The unit suite below covers the JS branch logic, the
 * driver-shape contract, and the catch-path behavior that the read-path
 * integration tests don't reach.
 */

const mockCaptureMirrorFailure = jest.fn();
jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  captureMirrorFailure: mockCaptureMirrorFailure,
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
    it('returns false when rotation_id is set (positive)', async () => {
      const entry = { ...baseEntry, rotation_id: 42 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    // Read-path parity (BS#1432 round-2 review): the read path's
    // `${flowsheet.rotation_id} IS NULL` gate treats any non-NULL value as
    // "FK lane owns this row". Helper now matches that exactly via
    // `rotation_id != null`, so 0 and negative drift values short-circuit
    // here instead of running the DB lookup.
    it('returns false when rotation_id is 0 (non-NULL means FK lane owns)', async () => {
      const entry = { ...baseEntry, rotation_id: 0 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).not.toHaveBeenCalled();
    });

    it('returns false when rotation_id is negative (non-NULL means FK lane owns)', async () => {
      const entry = { ...baseEntry, rotation_id: -1 };
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

    // Read-path parity (BS#1432 round-2 review): JS-side trim is NOT
    // applied to the empty-guard because PG's `trim()` strips only ASCII
    // space while JS's `String.prototype.trim()` also strips Unicode
    // whitespace. Whitespace-only values now reach the DB (where the SQL
    // `lower(trim(coalesce(col, '')))` normalizes both sides identically)
    // instead of being short-circuited by JS-side `.trim().length === 0`.
    it('does not short-circuit on JS-trimmable whitespace-only artist_name (reaches DB)', async () => {
      mockDbExecute.mockResolvedValue([{ match: false }]);
      const entry = { ...baseEntry, artist_name: '   ' };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(false);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
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
      expect(mockCaptureMirrorFailure).toHaveBeenCalledTimes(1);
      expect(mockCaptureMirrorFailure).toHaveBeenCalledWith('rotation_lookup', { error: err }, 'warning');
    });

    it('does not call captureMirrorFailure on success', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      await isActiveRotationMatch(baseEntry);
      expect(mockCaptureMirrorFailure).not.toHaveBeenCalled();
    });

    it('does not call captureMirrorFailure on no-match', async () => {
      mockDbExecute.mockResolvedValue([{ match: false }]);
      await isActiveRotationMatch(baseEntry);
      expect(mockCaptureMirrorFailure).not.toHaveBeenCalled();
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

    // Driver-shape-contract tests (BS#1432 round-2 review). The helper
    // accesses `(result[0]?.match)` via `!!` coercion (rather than `=== true`)
    // so a future postgres-js or drizzle-orm change that returns rows in a
    // different shape doesn't silently disable the fallback. These tests pin
    // the contract:
    //   - bare-array `[{match: true}]` → true (current shape)
    //   - bare-array `[{match: false}]` → false (current shape, negative)
    //   - empty array → false (no rows)
    //   - wrapped-object `{rows: [...]}` → false (safe default; caller's
    //     responsibility to unwrap if a driver change lands)
    //   - `match: 't'` → true (truthy string survives coercion)
    //   - `match: null` → false
    it('coerces truthy match value via !! (string "t" treated as true)', async () => {
      mockDbExecute.mockResolvedValue([{ match: 't' }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(true);
    });

    it('coerces falsy match value via !! (null treated as false)', async () => {
      mockDbExecute.mockResolvedValue([{ match: null }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(false);
    });

    it('returns false when driver wraps rows in {rows: [...]} (safe default; needs an unwrap when shape changes)', async () => {
      mockDbExecute.mockResolvedValue({ rows: [{ match: true }] });
      const result = await isActiveRotationMatch(baseEntry);
      // Safe default: a future driver evolution that wraps rows MUST be
      // accompanied by an unwrap layer at the helper, or the fallback
      // silently regresses. This test locks that boundary so the
      // regression is loud.
      expect(result).toBe(false);
    });
  });
});
