/**
 * Unit tests for jobs/flowsheet-no-match-recheck query.ts (BS#2176).
 *
 * Pins the recurring sweep's candidate predicate: terminal `enriched_no_match`
 * track rows with a real artist name remain the idempotent candidate set, but
 * a row already recheck-attempted inside the TTL is suppressed until the
 * marker exits the window. Bounded by a per-run LIMIT (the "bounded drip, not
 * a full-cohort sweep" constraint) and ordered oldest-attempted-first so a
 * large backlog is drained fairly across many runs.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { loadCandidates } from '../../../../jobs/flowsheet-no-match-recheck/query';
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

  test('orders oldest-recheck-attempted (and never-attempted) first, then by id, and bounds with LIMIT', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await loadCandidates(14, 200);

    const text = renderSql((db.execute as jest.Mock).mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    expect(text).toMatch(/ORDER BY\s+f\."no_match_recheck_attempted_at"\s+ASC\s+NULLS\s+FIRST\s*,\s*f\."id"\s+ASC/i);
    expect(text).toMatch(/LIMIT/i);
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
