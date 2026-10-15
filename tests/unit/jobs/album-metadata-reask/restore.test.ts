/**
 * The re-ask's restore mode, as statements (BS#3148, tracker BS#3137 decision 7).
 *
 * The unit tier mocks `drizzle-orm`, so these pin the statements' text, their guards and the order `runRestore`
 * sends them in. That a write then a restore reproduces the original rows, skips a row touched since and is a no-op
 * the second time are claims about real rows: `tests/integration/album-metadata-reask.spec.js`.
 *
 * @see WXYC/Backend-Service#3148
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { db } from '@wxyc/database';
import { renderSql } from '../../../utils/render-sql';
import {
  RESTORE_STATEMENT_TIMEOUT_DEFAULT,
  restoreAlbumSql,
  restoreLibrarySql,
  restoreProbeSql,
  runRestore,
} from '../../../../jobs/album-metadata-reask/restore';

const execute = db.execute as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const flat = (chunk: unknown): string => renderSql(chunk).replace(/\s+/g, ' ').trim();

const RUN = { runId: 'run-1', albumIds: [] };
const UNTOUCHED = `JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = b.row_id AND am."updated_at" = b.written_at`;

describe('restoreAlbumSql', () => {
  const statement = flat(restoreAlbumSql(RUN));

  it("restores only this run's album writes whose row is untouched since, locking the row", () => {
    expect(statement).toContain(UNTOUCHED);
    expect(statement).toContain(`WHERE b.run_id = run-1::text AND b.target_table = 'album_metadata' FOR UPDATE OF am`);
  });

  it('sets all 13 imaged columns from the before-image, typed by the schema-qualified record, and bumps updated_at', () => {
    expect(statement).toContain(`jsonb_populate_record(NULL::"wxyc_schema"."album_metadata", h.before_image) p`);
    for (const column of ['discogs_url', 'genres', 'tracklist', 'artist_bio', 'bio_tokens']) {
      expect(statement).toContain(`"${column}" = p."${column}"`);
    }
    expect(statement.match(/" = p\."/g)).toHaveLength(13);
    expect(statement).toContain(`"updated_at" = NOW()`);
  });

  it('writes one restore marker per restored album in the same statement, naming the restored run', () => {
    expect(statement).toContain(
      `SELECT run-1::text, 'restore', h.album_id, h.album_id, h.after_image, h.before_image, jsonb_build_object('restored_run_id', run-1::text, 'restored_write', h.provenance), NOW() FROM hit h JOIN restored r ON r.album_id = h.album_id`
    );
  });
});

describe('restoreLibrarySql', () => {
  const statement = flat(restoreLibrarySql(RUN));

  it("ties each catalog cover to its album's own write, which must be untouched since", () => {
    expect(statement).toContain(
      `JOIN "wxyc_schema"."album_metadata_reask_backup" b ON b.run_id = lb.run_id AND b.target_table = 'album_metadata' AND b.row_id = lb.album_id ${UNTOUCHED}`
    );
  });

  it('restores only a catalog cover that still equals the one the pass wrote, locking both rows', () => {
    expect(statement).toContain(
      `JOIN "wxyc_schema"."library" l ON l."id" = lb.row_id AND l."artwork_url" IS NOT DISTINCT FROM lb.after_image->>'artwork_url' WHERE lb.run_id = run-1::text AND lb.target_table = 'library' FOR UPDATE OF am, l`
    );
    expect(statement).toMatch(
      /UPDATE "wxyc_schema"\."library" l SET "artwork_url" = h\.prior_cover FROM hit h WHERE l\."id" = h\.id RETURNING l\."id"$/
    );
  });
});

describe('restoreProbeSql', () => {
  it('counts each target unlocked, and reads only', () => {
    const probe = flat(restoreProbeSql(RUN));
    expect(probe).toContain(flat(restoreAlbumSql(RUN)).split('WITH hit AS ( ')[1].split(' FOR UPDATE OF am')[0]);
    expect(probe).toMatch(
      /AS album_metadata_backups, .* AS album_metadata_restorable, .* AS library_backups, .* AS library_restorable FROM "wxyc_schema"\."album_metadata_reask_backup" b WHERE b\.run_id = run-1::text$/
    );
    expect(probe).not.toMatch(/FOR UPDATE|INSERT|UPDATE "/);
  });

  it('narrows the backup counts and every target to the listed albums', () => {
    const probe = flat(restoreProbeSql({ runId: 'run-1', albumIds: [7, 9] }));
    expect(probe.match(/ b\.run_id = run-1::text AND b\.album_id = ANY\(\{7,9\}::int\[\]\)/g)).toHaveLength(2);
    expect(probe.match(/lb\.run_id = run-1::text AND lb\.album_id = ANY\(\{7,9\}::int\[\]\)/g)).toHaveLength(1);
  });
});

describe('runRestore', () => {
  beforeEach(() => {
    execute.mockReset();
    (db.transaction as unknown as jest.Mock).mockClear();
  });

  const SET_LOCAL = "SET LOCAL statement_timeout = '45000ms'";
  const probe = (
    album_backups: number,
    album_restorable: number,
    library_backups: number,
    library_restorable: number
  ) => [
    {
      album_metadata_backups: album_backups,
      album_metadata_restorable: album_restorable,
      library_backups,
      library_restorable,
    },
  ];
  const ids = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
  const target = (backed_up: number, restorable: number, restored: number) => ({ backed_up, restorable, restored });
  const ANALYZE_LIBRARY = 'ANALYZE "wxyc_schema"."library"';
  const ANALYZE_ALBUMS = 'ANALYZE "wxyc_schema"."album_metadata"';

  it.each([
    // [label, execute, responses after SET LOCAL, statements sent, album_metadata, library]
    [
      'a dry run sends only the probe',
      false,
      [probe(3, 2, 1, 1)],
      [SET_LOCAL, 'probe'],
      target(3, 2, 0),
      target(1, 1, 0),
    ],
    [
      'nothing restorable sends only the probe',
      true,
      [probe(3, 0, 1, 0)],
      [SET_LOCAL, 'probe'],
      target(3, 0, 0),
      target(1, 0, 0),
    ],
    // A zero-row library UPDATE would still bump the catalog watermark.
    [
      'no library rows to restore sends only the album statement',
      true,
      [probe(3, 2, 0, 0), ids(2), []],
      [SET_LOCAL, 'probe', 'album', SET_LOCAL, ANALYZE_ALBUMS],
      target(3, 2, 2),
      target(0, 0, 0),
    ],
    [
      'the library statement goes first, then the album statement, then ANALYZE on each',
      true,
      [probe(3, 2, 1, 1), ids(1), ids(2), [], [], []],
      [SET_LOCAL, 'probe', 'library', 'album', SET_LOCAL, ANALYZE_LIBRARY, SET_LOCAL, ANALYZE_ALBUMS],
      target(3, 2, 2),
      target(1, 1, 1),
    ],
  ])('%s', async (_label, executeRestore, responses, sent, album_metadata, library) => {
    execute.mockResolvedValueOnce([]); // SET LOCAL
    for (const response of responses) {
      execute.mockResolvedValueOnce(response);
    }

    expect(await runRestore(RUN, { execute: executeRestore, timeoutMs: 45_000 })).toEqual({
      album_metadata,
      library,
      analyze_error: null,
    });

    const kinds: Record<string, string> = {
      probe: flat(restoreProbeSql(RUN)),
      library: flat(restoreLibrarySql(RUN)),
      album: flat(restoreAlbumSql(RUN)),
    };
    expect(execute.mock.calls.map(([statement]) => flat(statement))).toEqual(sent.map((s) => kinds[s] ?? s));
  });

  it('reports a failed ANALYZE instead of throwing: the restore has already committed', async () => {
    execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(probe(1, 1, 0, 0))
      .mockResolvedValueOnce(ids(1))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));

    expect(await runRestore(RUN, { execute: true, timeoutMs: 45_000 })).toMatchObject({
      album_metadata: target(1, 1, 1),
      analyze_error: 'canceling statement due to statement timeout',
    });
  });

  it('runs the probe and the writes in one transaction, under the five-minute default', async () => {
    execute.mockResolvedValue(probe(0, 0, 0, 0));

    await runRestore(RUN, { execute: true });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(RESTORE_STATEMENT_TIMEOUT_DEFAULT).toBe(300_000);
    expect(flat(execute.mock.calls[0][0])).toBe("SET LOCAL statement_timeout = '300000ms'");
  });
});
