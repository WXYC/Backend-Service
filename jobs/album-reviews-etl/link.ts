/**
 * Library link pass for album-reviews-etl: best-effort FK from
 * `album_review_submissions.album_id` to `library.id`. Pure SQL + TS —
 * no API cost, no attempt-at marker needed at this volume (~1.7k rows).
 *
 * Candidates are the still-unlinked rows (`album_id IS NULL AND
 * artist_name IS NOT NULL`): all rows on the first run, new and
 * previously-unmatched rows thereafter. ONE query sweeps `library`, then
 * both tiers below decide TS-side against that single result set.
 *
 * TWO TIERS, exact first (the linkage-widening measurement, 2026-08-25):
 *
 *   1. EXACT — byte-identical to the original v1 rule. Artist leg is the
 *      migration-0092 SQL twin `normalize_artist_name(...)` over BOTH
 *      `artist_name` and `album_artist`; album leg is `normalizeAlbumTitle`
 *      equality, which is exactly why the submissions table persists
 *      `norm_album`.
 *
 *   2. RELAXED — runs ONLY on the rows tier 1 left undecided. Artist leg
 *      adds `alternate_artist_name` (the library's co-filing convention:
 *      "The Smile — Wall of Eyes" is filed under Thom Yorke with the band
 *      in the alternate column) and compares under migration 0134's
 *      `fold_artist_name` twin, so a diacritic spelling matches its
 *      ASCII-folded filing. Album leg compares under `relaxedAlbumKey`
 *      (fold + punctuation-to-separator), so "Nerve Bumps (A Queer Divine
 *      Satisfaction)" reaches "Nerve Bumps: a queer divine satisfaction".
 *
 * Running exact FIRST is load-bearing, not just an optimization: the
 * relaxed keys are a strict coarsening, so a pair of library rows that the
 * exact tier separates (two "Markolino Dimond — Brujeria" rows differing
 * only in punctuation) would collapse to ambiguous under relaxed alone.
 * Tier 1 keeps its singleton; tier 2 only ever sees what tier 1 left
 * UNMATCHED. A tier-1 ambiguity is settled at tier 1 — relaxing a pair of
 * byte-identical matches can never produce a link, only keep the ambiguity
 * or decline it outright.
 *
 * Measured on prod 2026-08-25 over the 945 unlinked rows: +146 linked, and
 * ZERO new ambiguity. Replayed over the 744 already-linked rows the
 * widened matcher elects the same library row 743 times and a DIFFERENT
 * row zero times (the 744th is a genuine duplicate library row, correctly
 * declined). Deliberately NOT included: trigram/fuzzy album matching —
 * measured false positives at similarity 0.84–0.88 ("Erotic Probiotic 2" →
 * "Erotic Probiotic", "Black Metal 2" → "Black Metal", "Keyboard Suite I" →
 * "Keyboard Suite II"), and a wrong `album_id` is sticky.
 *
 * Link rule (UNCHANGED): EXACTLY ONE library match writes the FK (the
 * singleton rule — the concerts FK-loop-close precedent); zero or many
 * never write. The UPDATE is guarded `WHERE album_id IS NULL`, so a manual
 * correction or a prior link always wins — this pass never overwrites
 * anything.
 *
 * Schema-qualified table refs honour `WXYC_SCHEMA_NAME` (parallel Jest
 * workers override the var so each worker targets its own schema).
 */

import { sql, and, eq, isNull } from 'drizzle-orm';
import { db, album_review_submissions, normalizeAlbumTitle, foldArtistName } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const SUBMISSIONS_TABLE = sql.raw(`"${SCHEMA}"."album_review_submissions"`);
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const NORMALIZE_FN = sql.raw(`"${SCHEMA}"."normalize_artist_name"`);
const FOLD_FN = sql.raw(`"${SCHEMA}"."fold_artist_name"`);

/** Which comparison keys a decision uses. See the file header. */
export type LinkTier = 'exact' | 'relaxed';

export type UnlinkedSubmission = {
  id: number;
  norm_artist: string;
  norm_album: string;
};

/**
 * The relaxed tier's album key: Unicode-fold the already-normalized title,
 * then reduce every run of non-alphanumerics to a single separator.
 *
 * Deliberately job-local and computed at MATCH time on both sides. The
 * persisted `album_review_submissions.norm_album` stays exactly
 * `normalizeAlbumTitle` output — that column is a shared dedup-key contract
 * (`flowsheet_freetext_resolution` keys its PRIMARY KEY on the same
 * function), so relaxing it in place would silently re-key persisted rows.
 * Layering a second key on top costs nothing and re-keys nothing.
 *
 * Measured axes this recovers, in order of yield: punctuation (colon vs
 * parenthetical subtitle, comma, apostrophe, slash, ellipsis) and
 * diacritics. It does NOT drop words, so "Black Metal 2" still cannot
 * reach "Black Metal".
 *
 * THE FOLD IS IMPORTED, NOT REIMPLEMENTED (the `jobs/va-apple-music-url-
 * remediation/va-artist.ts` precedent). The diacritic half of this key is
 * exactly `foldArtistName` — NFD, strip combining marks, lowercase — which
 * is also the twin of the `fold_artist_name` the sweep's WHERE applies, so
 * the net and this key fold identically by construction rather than by two
 * hand-rolled copies agreeing. Only the punctuation collapse is local. That
 * `relaxedAlbumKey` is job-local means it is applied at MATCH time and
 * persisted nowhere; it does not mean it must re-derive primitives the
 * package already exports.
 *
 * Deliberate near-twin: `looseTitleKey` in `shared/lml-client/src/trust.ts`
 * runs the same algorithm for the same purpose (match a hand-typed title
 * against a catalog title). It is NOT shared, and cannot be —
 * `@wxyc/lml-client` may not depend on `@wxyc/database`, argued at length in
 * that file's docblock. One difference is real rather than incidental: it
 * strips `\p{M}+` (all Unicode marks) where this strips only the Combining
 * Diacritical Marks block, because this half is `foldArtistName`, whose output
 * must stay byte-identical to SQL `fold_artist_name`. The two agree on Latin
 * script and can diverge on Devanagari/Vietnamese.
 */
const NON_ALPHANUMERIC_RUN = /[^\p{L}\p{N}]+/gu;

export const relaxedAlbumKey = (normalizedTitle: string | null | undefined): string =>
  foldArtistName(normalizedTitle).replace(NON_ALPHANUMERIC_RUN, ' ').trim();

/** Raw SQL projection from the library sweep. */
export type LibraryCandidateRow = {
  id: number;
  album_title: string;
  /** `normalize_artist_name(coalesce(artist_name, ''))`, computed in SQL. */
  norm_primary: string;
  /** `normalize_artist_name(coalesce(album_artist, ''))`, computed in SQL. */
  norm_album_artist: string;
  /** `normalize_artist_name(coalesce(alternate_artist_name, ''))`, in SQL.
   *  Empty on the ~59.5k library rows that carry no alternate. */
  norm_alternate: string;
};

export type LibraryCandidate = LibraryCandidateRow & {
  /** `normalizeAlbumTitle(album_title)`, computed ONCE per candidate at
   *  load time — decideLink runs per (submission × candidate), and
   *  re-normalizing there would be K×M redundant regex passes for a
   *  multi-review artist. Same reasoning for every key below. */
  norm_album_title: string;
  /** `relaxedAlbumKey(norm_album_title)` — the relaxed tier's album leg. */
  relaxed_album_title: string;
  /** `foldArtistName` of each artist leg — the relaxed tier's artist legs. */
  fold_primary: string;
  fold_album_artist: string;
  fold_alternate: string;
};

/** TS-side half of the candidate projection (no SQL twin for album
 *  normalization — the reason the enrichment lives here, once per row). */
export const enrichCandidateRow = (row: LibraryCandidateRow): LibraryCandidate => {
  const norm_album_title = normalizeAlbumTitle(row.album_title);
  return {
    ...row,
    norm_album_title,
    relaxed_album_title: relaxedAlbumKey(norm_album_title),
    fold_primary: foldArtistName(row.norm_primary),
    fold_album_artist: foldArtistName(row.norm_album_artist),
    fold_alternate: foldArtistName(row.norm_alternate),
  };
};

export type LinkDecision =
  { kind: 'linked'; library_id: number } | { kind: 'ambiguous'; library_ids: number[] } | { kind: 'unmatched' };

/**
 * Run counters.
 *
 * These do NOT partition the candidate cohort, and the split into tier
 * counters must not be read as if they did. A row whose guarded UPDATE
 * declines — linked out-of-band between this run's SELECT and its UPDATE — is
 * counted by nothing, so `linked + link_ambiguous + link_unmatched` can come
 * in under the candidate count. That gap is the out-of-band-link signal, not a
 * lost row; it is deliberate (only rows this run actually wrote are counted as
 * linked) and predates the widening.
 */
export type LinkTotals = {
  /** Total rows linked this run = linked_exact + linked_relaxed. Kept as
   *  the headline counter so an existing dashboard/log reader is unaffected. */
  linked: number;
  /** Linked by the tier-1 rule (byte-identical to the pre-widening job). */
  linked_exact: number;
  /** Linked by the tier-2 rule (alternate-artist / fold / punctuation). */
  linked_relaxed: number;
  link_ambiguous: number;
  link_unmatched: number;
};

/**
 * The all-zero `LinkTotals`. Exported so the counter NAMES live in exactly one
 * place: this factory feeds `linkSubmissions`'s accumulator, the orchestrator's
 * `emptyTotals`, and the unit tests' expected shape. Adding a tier counter is
 * then two edits (the type and this factory), not the eight the widening cost.
 */
export const emptyLinkTotals = (): LinkTotals => ({
  linked: 0,
  linked_exact: 0,
  linked_relaxed: 0,
  link_ambiguous: 0,
  link_unmatched: 0,
});

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
 * ONE sweep of `library` for every row whose normalized artist_name,
 * album_artist, OR alternate_artist_name is in `norms` — or whose FOLDED
 * form is in `foldedNorms`. Both tiers decide against this single result
 * set; the relaxed pass issues no query of its own.
 *
 * `normalized` is MATERIALIZED because its three columns are read from BOTH
 * the outer WHERE and the projection; inlined, the OR-across-legs predicate
 * re-evaluates `normalize_artist_name` several times per row.
 *
 * `folded` is MATERIALIZED for a WEAKER reason, recorded here so nobody
 * re-derives it as the same rule: its columns are read only from the WHERE,
 * never from the projection. Dropping the fence would inline the folds into
 * the outer WHERE and let them evaluate lazily — but it would also change the
 * plan's dependence on qual ordering, so the fence stays. The cost it buys is
 * a SECOND full-library tuplestore (~64k rows re-projected with three extra
 * text columns the outer SELECT then discards), which is the honest price of
 * a deterministic plan here.
 *
 * The CPU half of that price is bought back by the `CASE` guards below rather
 * than by removing the fence. `fold_artist_name('')` is `''`, so gating each
 * fold on its leg being non-empty is a SEMANTIC NO-OP — every output column is
 * byte-identical — while cutting the fold count from 3×64k ≈ 192k per run to
 * ≈68.5k: `album_artist` is empty on 100% of library rows and
 * `alternate_artist_name` on ~59.5k of them, so ~65% of the unguarded folds
 * were computed and discarded. PostgreSQL guarantees CASE does not evaluate
 * unneeded subexpressions, which the AND-ordering inside the WHERE does not.
 *
 * THE SQL FOLD IS A NET, NOT THE DECISION. `enrichCandidateRow` recomputes
 * every fold with the TS twin and `decideLink` compares TS-folded probe
 * against TS-folded candidate, so both sides of every `===` come from ONE
 * implementation. If the twin and migration 0134's SQL function ever drift,
 * the only reachable effect is a row this net fetched that TS then declines,
 * or one it never fetched — a MISSED link, never a wrong one. Selecting the
 * SQL fold columns and deciding on those instead would put the two engines
 * on opposite sides of the same comparison, which is the one arrangement
 * that could turn drift into a bad `album_id`.
 *
 * The `<> ''` guards are load-bearing, not tidiness: `album_artist` is
 * empty on ALL ~64k library rows today and `alternate_artist_name` on
 * ~59.5k of them, so an empty probe norm would otherwise match the entire
 * library on those legs. The album comparison happens TS-side.
 */
export const loadCandidates = async (norms: string[], foldedNorms: string[]): Promise<LibraryCandidate[]> => {
  // Single text[] param each (see textArrayLiteral) — never interpolate the
  // JS array itself.
  const normsArrayLiteral = textArrayLiteral(norms);
  const foldedArrayLiteral = textArrayLiteral(foldedNorms);
  const result: unknown = await db.execute(sql`
    WITH normalized AS MATERIALIZED (
      SELECT
        "id",
        "album_title",
        ${NORMALIZE_FN}(coalesce("artist_name", '')) AS norm_primary,
        ${NORMALIZE_FN}(coalesce("album_artist", '')) AS norm_album_artist,
        ${NORMALIZE_FN}(coalesce("alternate_artist_name", '')) AS norm_alternate
      FROM ${LIBRARY_TABLE}
    ),
    folded AS MATERIALIZED (
      SELECT
        "id",
        "album_title",
        norm_primary,
        norm_album_artist,
        norm_alternate,
        CASE WHEN norm_primary <> '' THEN ${FOLD_FN}(norm_primary) ELSE '' END AS fold_primary,
        CASE WHEN norm_album_artist <> '' THEN ${FOLD_FN}(norm_album_artist) ELSE '' END AS fold_album_artist,
        CASE WHEN norm_alternate <> '' THEN ${FOLD_FN}(norm_alternate) ELSE '' END AS fold_alternate
      FROM normalized
    )
    SELECT "id", "album_title", norm_primary, norm_album_artist, norm_alternate
    FROM folded
    WHERE (norm_primary <> ''
             AND (norm_primary = ANY(${normsArrayLiteral}::text[])
                  OR fold_primary = ANY(${foldedArrayLiteral}::text[])))
       OR (norm_album_artist <> ''
             AND (norm_album_artist = ANY(${normsArrayLiteral}::text[])
                  OR fold_album_artist = ANY(${foldedArrayLiteral}::text[])))
       OR (norm_alternate <> ''
             AND (norm_alternate = ANY(${normsArrayLiteral}::text[])
                  OR fold_alternate = ANY(${foldedArrayLiteral}::text[])))
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

/**
 * The pure singleton rule, at one tier. Candidates are a broad artist-leg
 * sweep; a match requires the tier's artist key on ANY of the tier's legs
 * plus the tier's album-key equality, deduped by library id.
 *
 * An empty artist or album key never matches anything — see the `<> ''`
 * note on `loadCandidates`. The early return below is what enforces that,
 * which makes the per-candidate `!== ''` conjuncts redundant BY CONSTRUCTION
 * (a candidate leg equal to a non-empty key cannot itself be empty). They
 * are kept deliberately, and should not be tidied away: an all-empty leg
 * matching every library row is the single most consequential failure this
 * file can have — `album_artist` is empty on 100% of production rows — and
 * that guard belongs at the comparison, not only in an early return twelve
 * lines above it.
 */
export const decideLink = (
  submission: UnlinkedSubmission,
  candidates: LibraryCandidate[],
  tier: LinkTier
): LinkDecision => {
  const relaxed = tier === 'relaxed';
  const artistKey = relaxed ? foldArtistName(submission.norm_artist) : submission.norm_artist;
  const albumKey = relaxed ? relaxedAlbumKey(submission.norm_album) : submission.norm_album;
  if (artistKey === '' || albumKey === '') return { kind: 'unmatched' };

  const matches = new Set<number>();
  for (const c of candidates) {
    const artistMatches = relaxed
      ? (c.fold_primary !== '' && c.fold_primary === artistKey) ||
        (c.fold_album_artist !== '' && c.fold_album_artist === artistKey) ||
        (c.fold_alternate !== '' && c.fold_alternate === artistKey)
      : (c.norm_primary !== '' && c.norm_primary === artistKey) ||
        (c.norm_album_artist !== '' && c.norm_album_artist === artistKey);
    if (!artistMatches) continue;
    if ((relaxed ? c.relaxed_album_title : c.norm_album_title) !== albumKey) continue;
    matches.add(c.id);
  }
  if (matches.size === 1) return { kind: 'linked', library_id: [...matches][0] };
  if (matches.size > 1) return { kind: 'ambiguous', library_ids: [...matches].sort((a, b) => a - b) };
  return { kind: 'unmatched' };
};

export type LinkDeps = {
  loadUnlinked: () => Promise<UnlinkedSubmission[]>;
  loadCandidates: (norms: string[], foldedNorms: string[]) => Promise<LibraryCandidate[]>;
  writeLink: (submissionId: number, libraryId: number) => Promise<boolean>;
};

const defaultDeps: LinkDeps = { loadUnlinked, loadCandidates, writeLink };

/**
 * Run the link pass. Dependencies are injectable for tests; production
 * uses the SQL implementations above.
 */
export const linkSubmissions = async (deps: Partial<LinkDeps> = {}): Promise<LinkTotals> => {
  const { loadUnlinked: load, loadCandidates: candidates, writeLink: write } = { ...defaultDeps, ...deps };
  const totals: LinkTotals = emptyLinkTotals();

  const unlinked = await load();
  if (unlinked.length === 0) return totals;

  // Group submissions by norm_artist so each distinct artist is decided
  // against one candidate bucket, then sweep the library ONCE — the whole
  // distinct-norm set (~800) fits a single `= ANY` comfortably.
  const byNorm = new Map<string, UnlinkedSubmission[]>();
  for (const submission of unlinked) {
    const group = byNorm.get(submission.norm_artist);
    if (group) group.push(submission);
    else byNorm.set(submission.norm_artist, [submission]);
  }

  const norms = [...byNorm.keys()];
  // Fold each distinct norm ONCE. The per-group lookup below needs the same
  // value the sweep was asked for, so memoize rather than re-folding ~800
  // names a second time.
  const foldByNorm = new Map(norms.map((n) => [n, foldArtistName(n)]));
  const foldedNorms = [...new Set(foldByNorm.values())];
  const allCandidates = await candidates(norms, foldedNorms);

  // Index candidates under EVERY artist key they can satisfy, in both the
  // normalized and the folded key space. Over-inclusion is harmless —
  // decideLink re-checks the legs for its own tier — but under-inclusion
  // would silently starve the relaxed pass.
  const candidatesByKey = new Map<string, LibraryCandidate[]>();
  const indexUnder = (key: string, candidate: LibraryCandidate): void => {
    if (key === '') return;
    const bucket = candidatesByKey.get(key);
    if (bucket) bucket.push(candidate);
    else candidatesByKey.set(key, [candidate]);
  };
  for (const candidate of allCandidates) {
    const keys = new Set([
      candidate.norm_primary,
      candidate.norm_album_artist,
      candidate.norm_alternate,
      candidate.fold_primary,
      candidate.fold_album_artist,
      candidate.fold_alternate,
    ]);
    for (const key of keys) indexUnder(key, candidate);
  }

  for (const [norm, group] of byNorm) {
    // The bucket spans both key spaces; dedupe by library id so a candidate
    // reachable under both doesn't appear twice.
    const bucket = new Map<number, LibraryCandidate>();
    for (const key of new Set([norm, foldByNorm.get(norm) ?? foldArtistName(norm)])) {
      for (const c of candidatesByKey.get(key) ?? []) bucket.set(c.id, c);
    }
    const artistCandidates = [...bucket.values()];

    for (const submission of group) {
      // Tier 1 first — its singleton must survive the relaxed tier's
      // coarser keys collapsing it into an ambiguous pair.
      const exact = decideLink(submission, artistCandidates, 'exact');
      if (exact.kind === 'linked') {
        // The guarded UPDATE can decline (row linked out-of-band since
        // the SELECT); only count rows actually written.
        if (await write(submission.id, exact.library_id)) totals.linked_exact += 1;
        continue;
      }

      if (exact.kind === 'ambiguous') {
        // Two library rows match byte-for-byte — a genuine duplicate. Relaxing
        // can only keep it ambiguous (coarsening) or, for a title whose
        // relaxed key is EMPTY while its exact key is not
        // (`normalizeAlbumTitle('!!!')` is `'!!!'`, and every character of it
        // is a separator to `relaxedAlbumKey`), decline it outright. Neither
        // can produce a link, so settle it here rather than re-deciding and
        // then having to carry this verdict across the result.
        totals.link_ambiguous += 1;
        continue;
      }

      const relaxed = decideLink(submission, artistCandidates, 'relaxed');
      if (relaxed.kind === 'linked') {
        if (await write(submission.id, relaxed.library_id)) totals.linked_relaxed += 1;
      } else if (relaxed.kind === 'ambiguous') {
        totals.link_ambiguous += 1;
      } else {
        totals.link_unmatched += 1;
      }
    }
  }

  totals.linked = totals.linked_exact + totals.linked_relaxed;
  return totals;
};
