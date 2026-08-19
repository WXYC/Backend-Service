/**
 * Unit tests for jobs/flowsheet-no-match-recheck query.ts (BS#2176, BS#2218).
 *
 * Pins the recurring sweep's candidate predicate: terminal `enriched_no_match`
 * track rows with a real artist name remain the idempotent candidate set, but
 * a row already recheck-attempted inside the TTL is suppressed until the
 * marker exits the window. Bounded by a per-run LIMIT (the "bounded drip, not
 * a full-cohort sweep" constraint).
 *
 * BS#2218 changed the ordering: previously-attempted (TTL-expired) rows still
 * lead, oldest-attempted-first, but the never-attempted (`NULLS FIRST`) tier's
 * tiebreak flipped from `id ASC` to `id DESC` (newest-first) — see
 * `query.ts`'s module docstring for why oldest-first stranded 2026 playcuts
 * 132,460 rows deep. BS#2218 also added an OFFSET cursor (`countCandidates` +
 * a `cursorOffset` param on `loadCandidates`) so a persistently-transient
 * head can't occupy every future run's window — see
 * `jobs/flowsheet-no-match-recheck/watermark.ts`.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { countCandidates, loadCandidates } from '../../../../jobs/flowsheet-no-match-recheck/query';
import { renderSql } from '../../../utils/render-sql';

describe('loadCandidates', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  test('selects terminal no-match track rows and keeps metadata_status as the idempotency gate', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([
      {
        id: 5308981,
        artist_name: 'Vladislav Delay',
        album_title: 'Entain',
        track_title: 'Kohde',
        album_id: null,
        discogs_unavailable: false,
      },
    ]);

    const rows = await loadCandidates(14, 200);

    expect(rows).toEqual([
      {
        id: 5308981,
        artist_name: 'Vladislav Delay',
        album_title: 'Entain',
        track_title: 'Kohde',
        album_id: null,
        discogs_unavailable: false,
      },
    ]);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"metadata_status"\s*=\s*'enriched_no_match'/i);
    expect(text).toMatch(/"entry_type"\s*=\s*'track'/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
  });

  test('suppresses recheck-attempted rows inside the TTL and permits them after the TTL', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toContain('"no_match_recheck_attempted_at" IS NULL');
    expect(text).toContain('"no_match_recheck_attempted_at" <= now() - (interval');
    expect(text).toContain("interval '1 day'");
  });

  test('orders never-attempted rows first (NULLS FIRST), then previously-attempted rows oldest-first, and bounds with LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/ORDER BY\s+f\."no_match_recheck_attempted_at"\s+ASC\s+NULLS\s+FIRST\s*,/i);
    expect(text).toMatch(/LIMIT/i);
  });

  test('BS#2218: never-attempted tiebreak is newest-first (id DESC) — a 2026 playcut sorts ahead of a 2004 one', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    // The never-attempted (NULLS FIRST) tier's tiebreak: `f."id"` DESC only
    // when the marker is NULL. `id` is monotonically assigned at insert time,
    // so a 2026 playcut (a large id, e.g. ~5,309,000 per the BS#2218
    // measurement) sorts strictly before a 2004 playcut (a small id, e.g.
    // ~200) under this CASE/DESC pair — the opposite of the pre-fix `id ASC`
    // tiebreak that put 22 years of history ahead of anything a listener can
    // currently see.
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/CASE WHEN f\."no_match_recheck_attempted_at" IS NULL THEN f\."id" END\s+DESC/i);
  });

  test('BS#2218: previously-attempted tier keeps its own id ASC tiebreak, independent of the never-attempted tier', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/CASE WHEN f\."no_match_recheck_attempted_at" IS NOT NULL THEN f\."id" END\s+ASC/i);
  });

  test('BS#2218: accepts a cursorOffset and appends it as OFFSET', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200, 400);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/OFFSET 400/i);
  });

  test('BS#2218: cursorOffset defaults to 0 (no behavior change for a caller that omits it)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/OFFSET 0/i);
  });

  test('does not key off metadata_attempt_at — the C6 sweep writer-discriminator marker stays untouched', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).not.toMatch(/metadata_attempt_at/i);
  });

  test('LEFT JOINs library on album_id and pre-reads discogs_unavailable, defaulting unlinked rows to false', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]);
    expect(text).toMatch(/LEFT\s+JOIN\s+"?wxyc_schema"?\."?library"?/i);
    expect(text).toMatch(/ON\s+f\."?album_id"?\s*=\s*l\."?id"?/i);
    expect(text).toMatch(/COALESCE\s*\(\s*l\."?discogs_unavailable"?\s*,\s*false\s*\)\s+AS\s+"?discogs_unavailable"?/i);
  });
});

describe('countCandidates', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  test('BS#2218: counts the same predicate loadCandidates uses, with no LIMIT/OFFSET/ORDER BY', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 137340 }]);

    const count = await countCandidates(14);

    expect(count).toBe(137340);
    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/COUNT\(\*\)/i);
    expect(text).toMatch(/FROM\s+"?wxyc_schema"?\."?flowsheet"?/i);
    expect(text).toMatch(/"metadata_status"\s*=\s*'enriched_no_match'/i);
    expect(text).toMatch(/"entry_type"\s*=\s*'track'/i);
    expect(text).toMatch(/"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(text).toContain('"no_match_recheck_attempted_at" IS NULL');
    expect(text).not.toMatch(/ORDER BY/i);
    expect(text).not.toMatch(/LIMIT/i);
    expect(text).not.toMatch(/OFFSET/i);
  });

  test('BS#2218: returns 0 when the predicate matches nothing', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ count: 0 }]);

    const count = await countCandidates(14);

    expect(count).toBe(0);
  });
});
