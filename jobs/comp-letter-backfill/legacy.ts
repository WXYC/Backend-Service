/**
 * The tubafrenzy side of the advisory cross-check (BS#2834): every frozen `LIBRARY_RELEASE` mapped to the call letters
 * and genre of the `LIBRARY_CODE` it was filed under, e.g. `Z-L` in genre 11 for a Rock compilation on the L shelf.
 *
 * Read from the archived final capture
 * (`s3://wxyc-archive/legacy/tubafrenzy/2026-09-16/wxycmusic-backup-2026-09-16-135233.sql.gz`, or the identical
 * 2026-09-21 re-dump — see `jobs/library-label-backfill/README.md`) with that job's tested mysqldump reader rather
 * than a second copy of it. That makes this job depend on another job's source file, declared in this job's tsconfig
 * `include`; if `library-label-backfill` is ever retired, move `dump.ts` somewhere both can reach rather than deleting it.
 */

import { iterTableRows, type DumpRow } from '../library-label-backfill/dump.js';
import type { LegacyRelease } from './backfill.js';

/** `LIBRARY_CODE`: ID, GENRE_ID, CALL_LETTERS, ... (column order from the dump's own DDL) */
const CODE_ID = 0;
const CODE_GENRE_ID = 1;
const CODE_CALL_LETTERS = 2;
/** `LIBRARY_RELEASE`: ID, CALL_NUMBERS, CALL_LETTERS, TITLE, FORMAT_ID, two timestamps, ALTERNATE_ARTIST_NAME, LIBRARY_CODE_ID, ... */
const RELEASE_ID = 0;
const RELEASE_CODE_ID = 8;

type Rows = AsyncIterable<DumpRow> | Iterable<DumpRow>;

/**
 * Map every `LIBRARY_RELEASE` id to its code's call letters and genre. A release whose code is NULL or missing is kept,
 * with null fields, so the cross-check can tell "filed under an unknown code" from "not in the dump at all".
 *
 * @throws when either table yields no rows: a wrong file, a schema-only dump or a renamed table would otherwise turn
 *         the whole cross-check into "not in dump" and let the run pass with nothing checked.
 */
export async function legacyReleasesById(codeRows: Rows, releaseRows: Rows): Promise<Map<number, LegacyRelease>> {
  const codes = new Map<string, LegacyRelease>();
  for await (const row of codeRows) {
    const id = row[CODE_ID];
    if (id === null) continue;
    const genreId = row[CODE_GENRE_ID];
    codes.set(id, {
      call_letters: row[CODE_CALL_LETTERS]?.trim() ?? null,
      genre_id: genreId === null ? null : Number(genreId),
    });
  }
  if (codes.size === 0) throw new Error('the dump has no LIBRARY_CODE rows; is this the right file?');

  const byRelease = new Map<number, LegacyRelease>();
  for await (const row of releaseRows) {
    const id = row[RELEASE_ID];
    if (id === null) continue;
    const codeId = row[RELEASE_CODE_ID];
    byRelease.set(
      Number(id),
      (codeId === null ? undefined : codes.get(codeId)) ?? { call_letters: null, genre_id: null }
    );
  }
  if (byRelease.size === 0) throw new Error('the dump has no LIBRARY_RELEASE rows; is this the right file?');
  return byRelease;
}

/** Read the two tables from a `mysqldump` `.sql.gz` on disk. */
export const readLegacyReleases = (dumpPath: string): Promise<Map<number, LegacyRelease>> =>
  legacyReleasesById(iterTableRows(dumpPath, 'LIBRARY_CODE'), iterTableRows(dumpPath, 'LIBRARY_RELEASE'));
