/**
 * Library link pass for album-reviews-etl: best-effort FK from
 * `album_review_submissions.album_id` to `library.id`. Pure SQL + TS —
 * no API cost, no attempt-at marker needed at this volume (~1.6k rows).
 *
 * Candidates are the still-unlinked rows (`album_id IS NULL AND
 * artist_name IS NOT NULL`): all rows on the first run, new and
 * previously-unmatched rows thereafter. One query sweeps
 * `library` on the artist leg using the migration-0092 SQL twin
 * `wxyc_schema.normalize_artist_name(...)` over BOTH `artist_name` and
 * `album_artist` (compilations file the artist in the latter), then the
 * album leg compares TS-side — `normalizeAlbumTitle` has no SQL twin,
 * which is exactly why the submissions table persists `norm_album`.
 *
 * Link rule: EXACTLY ONE library match writes the FK (the singleton rule
 * — the concerts FK-loop-close precedent); zero or many never write. The
 * UPDATE is guarded `WHERE album_id IS NULL`, so a manual correction or a
 * prior link always wins — this pass never overwrites anything.
 *
 * `alternate_artist_name` matching is a noted non-goal for v1.
 *
 * Schema-qualified table refs honour `WXYC_SCHEMA_NAME` (parallel Jest
 * workers override the var so each worker targets its own schema).
 */

import { sql, and, eq, isNull } from 'drizzle-orm';
import { db, album_review_submissions, normalizeAlbumTitle } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const SUBMISSIONS_TABLE = sql.raw(`"${SCHEMA}"."album_review_submissions"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const NORMALIZE_FN = sql.raw(`"${SCHEMA}"."normalize_artist_name"`);

export type UnlinkedSubmission = {
  id: number;
  norm_artist: string;
  norm_album: string;
};

/** Raw SQL projection from the library sweep. */
type LibraryCandidateRow = {
  id: number;
  album_title: string;
  /** `normalize_artist_name(coalesce(artist_name, ''))`, computed in SQL. */
  norm_primary: string;
  /** `normalize_artist_name(coalesce(album_artist, ''))`, computed in SQL. */
  norm_album_artist: string;
};

export type LibraryCandidate = LibraryCandidateRow & {
  /** `normalizeAlbumTitle(album_title)`, computed ONCE per candidate at
   *  load time — decideLink runs per (submission × candidate), and
   *  re-normalizing there would be K×M redundant regex passes for a
   *  multi-review artist. */
  norm_album_title: string;
};

/** TS-side half of the candidate projection (no SQL twin for album
 *  normalization — the reason the enrichment lives here, once per row). */
export const enrichCandidateRow = (row: LibraryCandidateRow): LibraryCandidate => ({
  ...row,
  norm_album_title: normalizeAlbumTitle(row.album_title),
});

export type LinkDecision =
  { kind: 'linked'; library_id: number } | { kind: 'ambiguous'; library_ids: number[] } | { kind: 'unmatched' };

export type LinkTotals = {
  linked: number;
  link_ambiguous: number;
  link_unmatched: number;
};

/** Normalize `db.execute` results across drizzle driver shapes
 *  (postgres-js returns an array; node-postgres `{ rows }`). */
const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error('album-reviews-etl link: unrecognized db.execute() result shape');
};

export const loadUnlinked = async (): Promise<UnlinkedSubmission[]> => {
  const result: unknown = await db.execute(sql`
    SELECT "id", "norm_artist", "norm_album"
    FROM ${SUBMISSIONS_TABLE}
    WHERE "album_id" IS NULL
      AND "artist_name" IS NOT NULL
      AND "norm_artist" IS NOT NULL
      AND "norm_album" IS NOT NULL
    ORDER BY "id" ASC
  `);
  return unwrapRows<UnlinkedSubmission>(result);
};

/** Quote one `text[]` array-literal element: escape backslashes FIRST,
 *  then double quotes, then wrap. Exported for the unit escaping table. */
const quoteArrayElement = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Render a JS string array as a single PG `text[]` array-literal param
 * (`'{"a","b"}'::text[]`) — the BS#1068/BS#1071 idiom
 * (album-level-backfill, alias-consumer): drizzle/postgres-js splats a JS
 * array interpolated into a raw sql fragment into N positional
 * placeholders (`ANY(($1, $2))`), which PG rejects with `op ANY/ALL
 * (array) requires array on right side`. The int[] jobs get away with a
 * bare join; norms are TEXT, so each element is double-quoted with
 * backslash/quote escaping — a band name carrying a comma, quote, brace,
 * or backslash must stay one element.
 */
export const textArrayLiteral = (values: string[]): string => `{${values.map(quoteArrayElement).join(',')}}`;

/**
 * One sweep of `library` for every row whose normalized artist_name OR
 * album_artist is in `norms`. The MATERIALIZED CTE forces each
 * normalize_artist_name to be evaluated exactly once per library row per
 * leg — inlined, the OR-across-both-legs predicate re-evaluates the
 * functions in both the WHERE and the projection (up to 4× per row).
 * The album comparison happens TS-side (`enrichCandidateRow`).
 */
export const loadCandidates = async (norms: string[]): Promise<LibraryCandidate[]> => {
  // Single text[] param (see textArrayLiteral) — never interpolate the JS
  // array itself.
  const normsArrayLiteral = textArrayLiteral(norms);
  const result: unknown = await db.execute(sql`
    WITH normalized AS MATERIALIZED (
      SELECT
        "id",
        "album_title",
        ${NORMALIZE_FN}(coalesce("artist_name", '')) AS norm_primary,
        ${NORMALIZE_FN}(coalesce("album_artist", '')) AS norm_album_artist
      FROM ${LIBRARY_TABLE}
    )
    SELECT "id", "album_title", norm_primary, norm_album_artist
    FROM normalized
    WHERE norm_primary = ANY(${normsArrayLiteral}::text[])
       OR norm_album_artist = ANY(${normsArrayLiteral}::text[])
  `);
  return unwrapRows<LibraryCandidateRow>(result).map(enrichCandidateRow);
};

/**
 * Guarded FK write: `WHERE album_id IS NULL` means a row linked manually
 * (or by a concurrent pass) is never overwritten. Returns whether a row
 * was actually written.
 */
export const writeLink = async (submissionId: number, libraryId: number): Promise<boolean> => {
  const t = album_review_submissions;
  const result = await db
    .update(t)
    .set({ album_id: libraryId })
    .where(and(eq(t.id, submissionId), isNull(t.album_id)))
    .returning({ id: t.id });
  return result.length > 0;
};

/** The pure singleton rule. Candidates are a broad artist-leg sweep;
 *  matches require the artist norm on EITHER leg plus the TS-side
 *  normalized album-title equality, deduped by library id. */
export const decideLink = (submission: UnlinkedSubmission, candidates: LibraryCandidate[]): LinkDecision => {
  const matches = new Set<number>();
  for (const c of candidates) {
    const artistMatches = c.norm_primary === submission.norm_artist || c.norm_album_artist === submission.norm_artist;
    if (!artistMatches) continue;
    if (c.norm_album_title !== submission.norm_album) continue;
    matches.add(c.id);
  }
  if (matches.size === 1) return { kind: 'linked', library_id: [...matches][0] };
  if (matches.size > 1) return { kind: 'ambiguous', library_ids: [...matches].sort((a, b) => a - b) };
  return { kind: 'unmatched' };
};

export type LinkDeps = {
  loadUnlinked: () => Promise<UnlinkedSubmission[]>;
  loadCandidates: (norms: string[]) => Promise<LibraryCandidate[]>;
  writeLink: (submissionId: number, libraryId: number) => Promise<boolean>;
};

const defaultDeps: LinkDeps = { loadUnlinked, loadCandidates, writeLink };

/**
 * Run the link pass. Dependencies are injectable for tests; production
 * uses the SQL implementations above.
 */
export const linkSubmissions = async (deps: Partial<LinkDeps> = {}): Promise<LinkTotals> => {
  const { loadUnlinked: load, loadCandidates: candidates, writeLink: write } = { ...defaultDeps, ...deps };
  const totals: LinkTotals = { linked: 0, link_ambiguous: 0, link_unmatched: 0 };

  const unlinked = await load();
  if (unlinked.length === 0) return totals;

  // Group submissions by norm_artist so each distinct artist is decided
  // against one candidate bucket, then sweep the library ONCE — the whole
  // distinct-norm set (~hundreds) fits a single `= ANY` comfortably.
  const byNorm = new Map<string, UnlinkedSubmission[]>();
  for (const submission of unlinked) {
    const group = byNorm.get(submission.norm_artist);
    if (group) group.push(submission);
    else byNorm.set(submission.norm_artist, [submission]);
  }

  const norms = [...byNorm.keys()];
  const allCandidates = await candidates(norms);

  // Index candidates under every norm they can satisfy (either leg).
  const candidatesByNorm = new Map<string, LibraryCandidate[]>();
  const indexUnder = (norm: string, candidate: LibraryCandidate): void => {
    const bucket = candidatesByNorm.get(norm);
    if (bucket) bucket.push(candidate);
    else candidatesByNorm.set(norm, [candidate]);
  };
  for (const candidate of allCandidates) {
    indexUnder(candidate.norm_primary, candidate);
    if (candidate.norm_album_artist !== candidate.norm_primary) {
      indexUnder(candidate.norm_album_artist, candidate);
    }
  }

  for (const [norm, group] of byNorm) {
    const artistCandidates = candidatesByNorm.get(norm) ?? [];
    for (const submission of group) {
      const decision = decideLink(submission, artistCandidates);
      if (decision.kind === 'linked') {
        // The guarded UPDATE can decline (row linked out-of-band since
        // the SELECT); only count rows actually written.
        if (await write(submission.id, decision.library_id)) totals.linked += 1;
      } else if (decision.kind === 'ambiguous') {
        totals.link_ambiguous += 1;
      } else {
        totals.link_unmatched += 1;
      }
    }
  }

  return totals;
};
