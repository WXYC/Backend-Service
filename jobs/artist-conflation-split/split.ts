/**
 * Importable core of the one-shot artist-conflation-split job (BS#2645), the
 * inverse of `jobs/artist-unicode-dedup`: where that job merges rows one fold
 * key should share, this one restores a row two acts should never have shared.
 *
 * The MySQL->Postgres import manufactured cross-genre artist identity from
 * names (tubafrenzy's ARTIST table was empty; the shelf slot was the only
 * identity), merging same-named acts onto one `artists` row (BS#2637). The
 * release-tie audit (WXYC/catalog-audits#30) confirms which merged rows are
 * genuinely two acts; this job consumes its directives and gives each
 * confirmed act its own row.
 *
 * A split moves exactly one thing per genre — the `genre_artist_crossreference`
 * row — and repoints that genre's `library` rows. The shelf code needs no
 * cascade: `library` stores neither call letters nor artist number, so every
 * release re-labels at read time through the moved crossreference. The six
 * reconciled-identity columns are never copied to the new row: a name-keyed
 * stamp belongs to at most one of the acts (BS#2644 keeps the identity ETL
 * from re-filling either row while the name is ambiguous).
 *
 * Split out from `job.ts` so the destructive functions can be exercised
 * against a real Postgres by `tests/integration/artist-conflation-split.spec.js`
 * without the module's top-level `main()` auto-run firing on import.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';

/** The transaction handle Drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default is dry-run; `--execute` opts into writes. */
export const EXECUTE = process.argv.includes('--execute');

export const schemaName = (): string => (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

const qualified = (table: string): SQL => sql.raw(`"${schemaName()}"."${table.replace(/"/g, '""')}"`);

/** The 6 nullable reconciled-identity columns carried ON the artists row. */
const IDENTITY_COLUMNS = [
  'discogs_artist_id',
  'musicbrainz_artist_id',
  'wikidata_qid',
  'spotify_artist_id',
  'apple_music_artist_id',
  'bandcamp_id',
] as const;

/**
 * FK sites deliberately NOT repointed, counted for the operator instead.
 * They are derived state whose consumers regenerate (aliases, similarity,
 * play counts, concerts, track-credit canonicalization links) — and for the
 * frozen legacy `artist_crossreference` rows, which act the librarian meant
 * is not mechanically knowable, so a repoint would guess. Three such rows
 * exist across all 204 conflated artists; the log hands them to the operator.
 */
export const REPORTED_SITES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'artist_crossreference', column: 'source_artist_id' },
  { table: 'artist_crossreference', column: 'target_artist_id' },
  { table: 'artist_library_crossreference', column: 'artist_id' },
  { table: 'artist_search_alias', column: 'artist_id' },
  { table: 'artist_search_alias', column: 'related_artist_id' },
  { table: 'artist_similar_artists', column: 'artist_id' },
  { table: 'artist_station_plays', column: 'artist_id' },
  { table: 'compilation_track_artist', column: 'track_artist_id' },
  { table: 'concerts', column: 'headlining_artist_id' },
  { table: 'concert_performers', column: 'artist_id' },
];

export interface SplitDirective {
  artistId: number;
  keepGenreId: number;
  splitGenreIds: number[];
  clearIdentity: boolean;
}

/**
 * Parse the audit's `split-directives.tsv` (WXYC/catalog-audits#30 contract:
 * `artist_id  artist_name  keep_genre_id  split_genre_ids  clear_identity`).
 * The header is validated so a column reorder in the producer fails loudly
 * here rather than silently swapping keep and split. `artist_name` is
 * carried in the file for human review only; the id is authoritative.
 */
export const parseDirectives = (tsv: string): SplitDirective[] => {
  const lines = tsv.split('\n').filter((l) => l.trim() !== '');
  const expected = 'artist_id\tartist_name\tkeep_genre_id\tsplit_genre_ids\tclear_identity';
  if (lines[0] !== expected) {
    throw new Error(`Unexpected directives header: ${JSON.stringify(lines[0])}; expected ${JSON.stringify(expected)}`);
  }
  return lines.slice(1).map((line, i) => {
    const cols = line.split('\t');
    if (cols.length !== 5) {
      throw new Error(`Directive line ${i + 2}: expected 5 columns, got ${cols.length}`);
    }
    const [artistId, , keepGenreId, splitGenreIds, clearIdentity] = cols;
    if (clearIdentity !== 'true' && clearIdentity !== 'false') {
      throw new Error(
        `Directive line ${i + 2}: clear_identity must be true|false, got ${JSON.stringify(clearIdentity)}`
      );
    }
    const splits = splitGenreIds.split(',').map((g) => Number(g));
    if (splits.length === 0 || splits.some((g) => !Number.isInteger(g) || g <= 0)) {
      throw new Error(`Directive line ${i + 2}: malformed split_genre_ids ${JSON.stringify(splitGenreIds)}`);
    }
    return {
      artistId: Number(artistId),
      keepGenreId: Number(keepGenreId),
      splitGenreIds: splits,
      clearIdentity: clearIdentity === 'true',
    };
  });
};

export interface DirectivePlan {
  directive: SplitDirective;
  artistName: string | null;
  /** Validation refusals; a non-empty list means the directive is skipped. */
  refusals: string[];
  /** Per split genre: the crossreference's code and the library rows to move. */
  perGenre: Array<{ genreId: number; artistGenreCode: number | null; libraryRows: number }>;
  /** Non-zero counts at the deliberately-unrepointed sites (see REPORTED_SITES). */
  reportedCounts: Record<string, number>;
}

/**
 * Validate one directive and size its affected set. Pure reads — this is the
 * dry-run body, and `executeDirective` re-runs it inside the write
 * transaction so the state it validated cannot drift before the writes.
 *
 * Refusal, never inference: a directive whose artist lacks a crossreference
 * row for a named genre (already split on a prior run, or wrong input) is
 * reported and skipped rather than guessed at — which also makes a completed
 * run idempotent.
 */
export const planDirective = async (d: SplitDirective, tx: Tx | typeof db = db): Promise<DirectivePlan> => {
  const refusals: string[] = [];

  const dupes = new Set(d.splitGenreIds);
  if (dupes.size !== d.splitGenreIds.length) refusals.push('split_genre_ids contains duplicates');
  if (dupes.has(d.keepGenreId)) refusals.push(`keep genre ${d.keepGenreId} also listed in split_genre_ids`);

  const artistRows = (await tx.execute(sql`
    SELECT artist_name FROM ${qualified('artists')} WHERE id = ${d.artistId}
  `)) as unknown as Array<{ artist_name: string }>;
  const artistName = artistRows[0]?.artist_name ?? null;
  if (artistName === null) refusals.push(`artist ${d.artistId} does not exist`);

  const gacRows = (await tx.execute(sql`
    SELECT genre_id, artist_genre_code FROM ${qualified('genre_artist_crossreference')}
    WHERE artist_id = ${d.artistId}
  `)) as unknown as Array<{ genre_id: number; artist_genre_code: number }>;
  const filed = new Map(gacRows.map((r) => [Number(r.genre_id), Number(r.artist_genre_code)]));

  if (artistName !== null && !filed.has(d.keepGenreId)) {
    refusals.push(`artist ${d.artistId} is not filed under keep genre ${d.keepGenreId}`);
  }
  for (const g of d.splitGenreIds) {
    if (artistName !== null && !filed.has(g)) {
      refusals.push(`artist ${d.artistId} is not filed under split genre ${g} (already split, or wrong input)`);
    }
  }
  if (artistName !== null && filed.size - dupes.size < 1) {
    refusals.push('split would leave the kept row with no genre membership');
  }

  const perGenre: DirectivePlan['perGenre'] = [];
  for (const g of d.splitGenreIds) {
    const lib = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM ${qualified('library')}
      WHERE artist_id = ${d.artistId} AND genre_id = ${g}
    `)) as unknown as Array<{ n: number }>;
    perGenre.push({ genreId: g, artistGenreCode: filed.get(g) ?? null, libraryRows: Number(lib[0]?.n ?? 0) });
  }

  const reportedCounts: Record<string, number> = {};
  for (const site of REPORTED_SITES) {
    const t = qualified(site.table);
    const res = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM ${t} WHERE ${sql.raw(`"${site.column}"`)} = ${d.artistId}
    `)) as unknown as Array<{ n: number }>;
    const n = Number(res[0]?.n ?? 0);
    if (n > 0) reportedCounts[`${site.table}.${site.column}`] = n;
  }

  return { directive: d, artistName, refusals, perGenre, reportedCounts };
};

export interface SplitResult {
  artistId: number;
  /** genre_id -> the new artists row that genre's filing moved to. */
  newArtistIds: Record<number, number>;
  libraryRowsRepointed: number;
  identityCleared: boolean;
}

/**
 * Execute one directive in a single transaction: re-validate, then per split
 * genre INSERT the new row (name columns copied, identity columns NULL),
 * move the genre's crossreference row, and repoint that genre's library
 * rows; finally clear the kept row's identity columns when the directive
 * says the stamp could not be placed. All-or-nothing per directive — a
 * mid-run abort leaves each artist either fully split or untouched.
 */
export const executeDirective = async (d: SplitDirective): Promise<SplitResult> => {
  const result: SplitResult = {
    artistId: d.artistId,
    newArtistIds: {},
    libraryRowsRepointed: 0,
    identityCleared: false,
  };

  await db.transaction(async (tx) => {
    const plan = await planDirective(d, tx);
    if (plan.refusals.length > 0) {
      throw new Error(`refused: ${plan.refusals.join('; ')}`);
    }

    const artistsTable = qualified('artists');
    for (const g of d.splitGenreIds) {
      const inserted = (await tx.execute(sql`
        INSERT INTO ${artistsTable} (artist_name, alphabetical_name, code_letters)
        SELECT artist_name, alphabetical_name, code_letters FROM ${artistsTable} WHERE id = ${d.artistId}
        RETURNING id
      `)) as unknown as Array<{ id: number }>;
      const newId = Number(inserted[0].id);
      result.newArtistIds[g] = newId;

      const moved = await tx.execute(sql`
        UPDATE ${qualified('genre_artist_crossreference')}
        SET artist_id = ${newId}
        WHERE artist_id = ${d.artistId} AND genre_id = ${g}
      `);
      if (Number(moved.count ?? 0) !== 1) {
        // planDirective just saw this row inside the same transaction, so 0
        // (or >1, which artist_genre_key makes impossible) means the world
        // model is wrong — abort the whole directive rather than continue.
        throw new Error(`crossreference move for genre ${g} touched ${Number(moved.count ?? 0)} rows, expected 1`);
      }

      const repointed = await tx.execute(sql`
        UPDATE ${qualified('library')}
        SET artist_id = ${newId}
        WHERE artist_id = ${d.artistId} AND genre_id = ${g}
      `);
      result.libraryRowsRepointed += Number(repointed.count ?? 0);
    }

    if (d.clearIdentity) {
      const clearSet = sql.raw(IDENTITY_COLUMNS.map((c) => `"${c}" = NULL`).join(', '));
      await tx.execute(sql`UPDATE ${artistsTable} SET ${clearSet} WHERE id = ${d.artistId}`);
      result.identityCleared = true;
    }
  });

  return result;
};

/**
 * ANALYZE the tables a split rewrites so the planner's stats stay on the
 * index path (docs/bulk-update-playbook.md; BS#934). Outside any
 * transaction; skipped in dry-run.
 */
export const analyzeTables = async (): Promise<void> => {
  for (const table of ['artists', 'library', 'genre_artist_crossreference']) {
    await db.execute(sql`ANALYZE ${qualified(table)}`);
  }
};

export const runSplit = async (directives: SplitDirective[]): Promise<void> => {
  console.log(`[artist-split] Mode: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY-RUN (no writes)'}`);
  console.log(`[artist-split] ${directives.length} directive(s) loaded.`);

  let executed = 0;
  let refused = 0;
  let libraryRows = 0;

  for (const d of directives) {
    const plan = await planDirective(d);
    const name = plan.artistName === null ? '(missing)' : JSON.stringify(plan.artistName);
    console.log(
      `[artist-split] #${d.artistId} ${name}: keep genre ${d.keepGenreId}, split [${d.splitGenreIds.join(', ')}]` +
        (d.clearIdentity ? ', clear identity' : '')
    );

    if (plan.refusals.length > 0) {
      refused += 1;
      for (const r of plan.refusals) console.log(`[artist-split]   ✗ refused: ${r}`);
      continue;
    }

    for (const g of plan.perGenre) {
      console.log(
        `[artist-split]   genre ${g.genreId}: move crossreference (code ${g.artistGenreCode}), repoint ${g.libraryRows} library row(s)`
      );
    }
    const reported = Object.entries(plan.reportedCounts)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    if (reported) {
      console.log(`[artist-split]   ⚠ rows left on the shared id for the operator: ${reported}`);
    }

    if (!EXECUTE) continue;

    const result = await executeDirective(d);
    executed += 1;
    libraryRows += result.libraryRowsRepointed;
    const created = Object.entries(result.newArtistIds)
      .map(([g, id]) => `genre ${g} -> #${id}`)
      .join(', ');
    console.log(`[artist-split]   ✓ split: ${created}; ${result.libraryRowsRepointed} library row(s) repointed.`);
  }

  if (EXECUTE) {
    console.log(
      `[artist-split] Executed ${executed} directive(s) (${refused} refused); ${libraryRows} library row(s) repointed.`
    );
    if (executed > 0) {
      await analyzeTables();
      console.log('[artist-split] ANALYZE complete on rewritten tables.');
    }
  } else {
    console.log(
      `[artist-split] DRY-RUN complete (${refused} directive(s) would be refused). Re-run with --execute to apply.`
    );
  }
  console.log('[artist-split] Done.');
};
