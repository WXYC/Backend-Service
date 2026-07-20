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
// BS#1707: the rotation-match probe moved to @wxyc/legacy-mirror and now imports
// captureMirrorFailure from its sibling `./http-mirror.js`, so the mock must
// target the shared source module, not the old apps/backend path.
jest.mock('../../../../shared/legacy-mirror/src/http-mirror', () => ({
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

import { isActiveRotationMatch } from '@wxyc/legacy-mirror';

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

  // Cohort (c) fires via the library+artists LEFT JOIN inside the EXISTS
  // query. Because the helper issues a single SQL call covering all three
  // cohorts as an OR, the unit mock cannot distinguish which cohort fired —
  // the structural test below pins that the JS branch logic correctly
  // propagates a DB match regardless of which cohort is responsible. The
  // read-path integration suite in flowsheet.spec.js exercises the actual
  // SQL predicates (including the library+artists JOIN path) against a real
  // PostgreSQL instance.
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

    // Round-3 review: pins the helper's `!= null` add_time check (vs the
    // round-1 falsy check that would have treated 0 as "no add_time"). With
    // add_time=0 (epoch ms = 1970-01-01) the helper must hit the DB and
    // pass the actual epoch into the kill_date filter — not silently fall
    // back to `new Date()` ("now"). Schema makes add_time NOT NULL so this
    // is theoretical in production, but pinning the contract prevents a
    // future "simplify the null check to a falsy ternary" refactor from
    // silently losing the 1970-01-01 timestamp.
    it('handles add_time=0 epoch (1970-01-01) as a real timestamp, not "no add_time"', async () => {
      mockDbExecute.mockResolvedValue([{ match: true }]);
      const entry = { ...baseEntry, add_time: 0 };
      const result = await isActiveRotationMatch(entry);
      expect(result).toBe(true);
      expect(mockDbExecute).toHaveBeenCalledTimes(1);
    });

    // Driver-shape-contract tests (BS#1432 round-2 / round-9 / round-10).
    //
    // postgres-js registers an OID 16 (boolean) parser `parse: x => x === 't'`
    // that converts the wire bytes 't'/'f' to JS true/false in the DataRow
    // handler before the result reaches application code. `SELECT EXISTS(...)`
    // always returns a JS boolean — the `match === true` check in the helper
    // is both sufficient and accurate for the current driver.
    //
    // The 'f' canary below is the key safety net: if the OID 16 parser were
    // ever removed (or the query routed through a raw client that skips it),
    // `match` would be the string 'f'. `'f' === true` is false, so the helper
    // correctly returns false. Had the helper used `!!` coercion, `!!('f')` ===
    // true would have caused a false positive — that is the bug this test pins.
    //
    // Tests pinning the contract:
    //   - `[{match: true}]`  → true  (current driver shape; `=== true` live branch)
    //   - `[{match: false}]` → false (current driver shape, negative)
    //   - empty array        → false (no rows)
    //   - `{rows: [...]}`    → false (safe default; needs unwrap if shape changes)
    //   - `match: 'f'`       → false (canary: string 'f' must never be truthy here)
    //   - `match: null`      → false

    it('returns false for PostgreSQL string "f" — canary against !! false-positive', async () => {
      // postgres-js normally converts 'f' to JS false via OID 16 parser,
      // so this shape only arises if the parser is bypassed. The test pins
      // that `=== true` (not `!!`) rejects 'f' as false in that scenario.
      mockDbExecute.mockResolvedValue([{ match: 'f' }]);
      const result = await isActiveRotationMatch(baseEntry);
      expect(result).toBe(false);
    });

    it('treats null match as false', async () => {
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
