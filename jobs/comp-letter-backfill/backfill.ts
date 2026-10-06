/**
 * Importable core of the one-shot comp-letter backfill (BS#2834, epic BS#2828).
 *
 * Fills `genre_artist_crossreference.code_comp_letter` on the 52 Rock/Soundtracks compilation slots: 26
 * `Various Artists - Rock - <L>` sections and 26 `Soundtracks - <L>` sections. Until now the letter has existed only
 * as the trailing ` - <L>` of the slot's artist name, so that is where it is read from — once, here, behind a gate.
 *
 * The gate is what makes reading a name safe. Each genre must come out as exactly A-Z with no gaps and no repeats, and
 * each name must be its genre's own form, so a section renamed or refiled since the cutover aborts the whole run
 * instead of going quietly unlettered. Nothing is written unless every check passes, and a set value is never
 * overwritten. `--apply` reads, gates and writes inside one transaction holding row locks on the slots and their
 * artists, so what was checked is what gets written.
 *
 * Takes the postgres.js handle from its caller and imports nothing at runtime, so the integration spec can run this
 * exact module (`dist/backfill.cjs`) against a real Postgres with its own pool.
 */

import type { Sql, TransactionSql } from 'postgres';

/** A pool or the open transaction `--apply` runs in. */
type Db = Sql | TransactionSql;

/** One candidate slot, with the letter read from its name and whatever letter it already carries. */
export interface Candidate {
  artist_id: number;
  genre_id: number;
  genre_name: string;
  artist_name: string;
  letter: string;
  code_comp_letter: string | null;
}

/** A `genre_artist_crossreference` row that already carries a letter, candidate or not. */
export interface LetteredSlot {
  artist_id: number;
  genre_id: number;
  code_comp_letter: string;
}

/** What the frozen tubafrenzy dump says about one legacy release. */
export interface LegacyRelease {
  /** Its `LIBRARY_CODE.CALL_LETTERS` (`Z-L` for the Rock L shelf), or null when its code is NULL or missing. */
  call_letters: string | null;
  /** Its code's `GENRE_ID`, which uses the same ids as Backend's `genres` (11 Rock, 12 Soundtracks). */
  genre_id: number | null;
}

/** A `library` row filed under a Rock/Soundtracks compilation slot, keyed back to tubafrenzy. */
export interface SlotRelease {
  artist_id: number;
  genre_id: number;
  legacy_release_id: number;
}

/** A release whose tubafrenzy filing does not match the slot it is under now: another letter, genre, or no code. */
export interface Disagreement {
  artist_id: number;
  genre_name: string;
  letter: string;
  legacy_release_id: number;
  legacy_call_letters: string | null;
  legacy_genre_id: number | null;
}

/**
 * The advisory cross-check's tally over every release under the 52 slots. Each release lands in exactly one bucket:
 * `agreed` (same letter and genre in the dump), `disagreements`, `notInDump` (a tubafrenzy-era id the dump has no row
 * for), or `backendMinted` (filed in Backend since the cutover, so there is nothing to compare against).
 */
export interface CrossCheckResult {
  agreed: number;
  disagreements: Disagreement[];
  notInDump: number;
  backendMinted: number;
}

export type Status = 'dry-run' | 'applied' | 'already-applied' | 'aborted';

export interface BackfillResult {
  status: Status;
  failures: string[];
  candidates: Candidate[];
  /** Null when no dump was given. */
  crossCheck: CrossCheckResult | null;
}

export interface BackfillOptions {
  schema: string;
  apply: boolean;
  log?: (line: string) => void;
  /** Every `LIBRARY_RELEASE` in the frozen dump, by id (see `legacy.ts`). Omitted: no cross-check. */
  legacyReleases?: Map<number, LegacyRelease>;
}

const GENRES = ['Rock', 'Soundtracks'] as const;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const EXPECTED_TOTAL = GENRES.length * ALPHABET.length;

/**
 * `legacy_release_id` values at or above this were minted by Backend (`library_legacy_release_id_seq`, BS#1963) and
 * have no tubafrenzy row to compare against.
 */
const BACKEND_MINTED_LEGACY_ID_FLOOR = 1_000_000;

/** Each genre's section name, minus the letter. A candidate's name must be exactly this plus its letter. */
const NAME_PREFIX: Record<(typeof GENRES)[number], string> = {
  Rock: 'Various Artists - Rock - ',
  Soundtracks: 'Soundtracks - ',
};

/**
 * The candidate set exactly as BS#2834 specifies it, plus the slot's current letter. Every condition is structural
 * except the trailing ` - <letter>`, which is the only place the letter exists today.
 */
export const findCandidates = (sql: Db, schema: string, lock = false) => sql<Candidate[]>`
  SELECT gac.artist_id, gac.genre_id, g.genre_name, a.artist_name, gac.code_comp_letter,
         upper(substring(btrim(a.artist_name) from ' - ([A-Za-z])$')) AS letter
    FROM ${sql(schema)}.genre_artist_crossreference gac
    JOIN ${sql(schema)}.artists a ON a.id = gac.artist_id
    JOIN ${sql(schema)}.genres  g ON g.id = gac.genre_id
   WHERE upper(btrim(a.code_letters)) = 'V/A'
     AND gac.artist_genre_code = 0
     AND g.genre_name IN ${sql(GENRES)}
     AND btrim(a.artist_name) ~ ' - [A-Za-z]$'
   ORDER BY g.genre_name, letter, gac.artist_id
   ${lock ? sql`FOR UPDATE OF gac, a` : sql``}
`;

/** Every row in the table that already carries a letter. Small: at most 52 once the backfill has run. */
const findLettered = (sql: Db, schema: string) => sql<LetteredSlot[]>`
  SELECT artist_id, genre_id, code_comp_letter
    FROM ${sql(schema)}.genre_artist_crossreference
   WHERE code_comp_letter IS NOT NULL
`;

/** Rock/Soundtracks `V/A` slots the candidate predicate leaves out. Expected: the catch-all's Soundtracks filing. */
const findUncovered = (sql: Db, schema: string) => sql<
  { artist_id: number; genre_name: string; artist_name: string }[]
>`
  SELECT gac.artist_id, g.genre_name, a.artist_name
    FROM ${sql(schema)}.genre_artist_crossreference gac
    JOIN ${sql(schema)}.artists a ON a.id = gac.artist_id
    JOIN ${sql(schema)}.genres  g ON g.id = gac.genre_id
   WHERE upper(btrim(a.code_letters)) = 'V/A'
     AND g.genre_name IN ${sql(GENRES)}
     AND NOT (gac.artist_genre_code = 0 AND btrim(a.artist_name) ~ ' - [A-Za-z]$')
   ORDER BY g.genre_name, gac.artist_id
`;

/**
 * Decide whether the write may run, from the candidates and every lettered row in the table. `alreadyApplied` is a
 * completed earlier run — every candidate carries exactly the letter its name gives and nothing else is lettered —
 * which makes a re-run a no-op rather than a failure. Any other set value is a failure, so a dry run and `--apply` see
 * the same state and reach the same verdict.
 */
export function checkGate(
  candidates: Candidate[],
  lettered: LetteredSlot[]
): { failures: string[]; alreadyApplied: boolean } {
  const failures: string[] = [];
  if (candidates.length !== EXPECTED_TOTAL) {
    failures.push(`expected ${EXPECTED_TOTAL} candidate slots, found ${candidates.length}`);
  }
  for (const genre of GENRES) {
    const inGenre = candidates.filter((c) => c.genre_name === genre);
    const letters = inGenre.map((c) => c.letter);
    if (letters.length !== ALPHABET.length) {
      failures.push(`${genre}: expected ${ALPHABET.length} slots, found ${letters.length}`);
    }
    const missing = ALPHABET.filter((l) => !letters.includes(l));
    const duplicates = [...new Set(letters.filter((l, i) => letters.indexOf(l) !== i))];
    if (missing.length > 0) failures.push(`${genre}: missing ${missing.join(', ')}`);
    if (duplicates.length > 0) failures.push(`${genre}: duplicate ${duplicates.join(', ')}`);
    for (const c of inGenre) {
      const expected = `${NAME_PREFIX[genre]}${c.letter}`;
      if (c.artist_name.trim().toLowerCase() !== expected.toLowerCase()) {
        failures.push(`${genre} ${c.letter} (artist ${c.artist_id}): name '${c.artist_name}' is not '${expected}'`);
      }
    }
  }

  const candidateKeys = new Set(candidates.map((c) => `${c.artist_id}:${c.genre_id}`));
  for (const l of lettered.filter((l) => !candidateKeys.has(`${l.artist_id}:${l.genre_id}`))) {
    failures.push(
      `artist ${l.artist_id} in genre ${l.genre_id} carries code_comp_letter '${l.code_comp_letter}' but is not a candidate`
    );
  }

  const alreadyApplied = failures.length === 0 && candidates.every((c) => c.code_comp_letter === c.letter);
  if (!alreadyApplied) {
    for (const c of candidates.filter((c) => c.code_comp_letter !== null)) {
      failures.push(
        `${c.genre_name} ${c.letter} (artist ${c.artist_id}) already carries code_comp_letter '${c.code_comp_letter}'`
      );
    }
  }
  return { failures, alreadyApplied };
}

/**
 * Compare each release under a candidate slot with how the frozen tubafrenzy dump filed it. Advisory only: a release
 * legitimately re-filed to another section after the cutover disagrees with the dump, so disagreements are listed for
 * a human, never treated as a gate failure.
 */
export function crossCheck(
  candidates: Candidate[],
  releases: SlotRelease[],
  legacyReleases: Map<number, LegacyRelease>
): CrossCheckResult {
  const slots = new Map(candidates.map((c) => [`${c.artist_id}:${c.genre_id}`, c]));
  const result: CrossCheckResult = { agreed: 0, disagreements: [], notInDump: 0, backendMinted: 0 };
  for (const release of releases) {
    const slot = slots.get(`${release.artist_id}:${release.genre_id}`);
    if (!slot) continue;
    if (release.legacy_release_id >= BACKEND_MINTED_LEGACY_ID_FLOOR) {
      result.backendMinted += 1;
      continue;
    }
    const legacy = legacyReleases.get(release.legacy_release_id);
    if (legacy === undefined) {
      result.notInDump += 1;
      continue;
    }
    const legacyLetter = legacy.call_letters === null ? null : /^Z-([A-Z])$/i.exec(legacy.call_letters)?.[1];
    if (legacyLetter?.toUpperCase() === slot.letter && legacy.genre_id === slot.genre_id) {
      result.agreed += 1;
    } else {
      result.disagreements.push({
        artist_id: slot.artist_id,
        genre_name: slot.genre_name,
        letter: slot.letter,
        legacy_release_id: release.legacy_release_id,
        legacy_call_letters: legacy.call_letters,
        legacy_genre_id: legacy.genre_id,
      });
    }
  }
  return result;
}

/** Every release under a Rock/Soundtracks code-0 slot; `crossCheck` keeps the ones under a candidate. */
const findSlotReleases = (sql: Db, schema: string) => sql<SlotRelease[]>`
  SELECT l.artist_id, l.genre_id, l.legacy_release_id
    FROM ${sql(schema)}.library l
    JOIN ${sql(schema)}.genre_artist_crossreference gac ON gac.artist_id = l.artist_id AND gac.genre_id = l.genre_id
    JOIN ${sql(schema)}.genres g ON g.id = l.genre_id
   WHERE gac.artist_genre_code = 0 AND g.genre_name IN ${sql(GENRES)}
`;

const describeFiling = (callLetters: string | null, genreId: number | null) =>
  `${callLetters ?? 'no code'} in genre ${genreId ?? '?'}`;

/**
 * Write the 52 letters inside the caller's transaction, one bound UPDATE per slot, each guarded
 * `code_comp_letter IS NULL` and required to touch exactly one row. Before commit, the table must hold exactly 52
 * letters in total, so a run can never leave any other row lettered.
 */
async function applyLetters(tx: Db, schema: string, candidates: Candidate[]): Promise<void> {
  for (const c of candidates) {
    const updated = await tx`
      UPDATE ${tx(schema)}.genre_artist_crossreference
         SET code_comp_letter = ${c.letter}
       WHERE artist_id = ${c.artist_id} AND genre_id = ${c.genre_id} AND code_comp_letter IS NULL
    `;
    if (updated.count !== 1) {
      throw new Error(
        `${c.genre_name} ${c.letter} (artist ${c.artist_id}): expected 1 row updated, got ${updated.count}`
      );
    }
  }
  const [{ lettered }] = await tx<{ lettered: number }[]>`
    SELECT count(*)::int AS lettered FROM ${tx(schema)}.genre_artist_crossreference WHERE code_comp_letter IS NOT NULL
  `;
  if (lettered !== EXPECTED_TOTAL) {
    throw new Error(`expected ${EXPECTED_TOTAL} lettered slots after the write, found ${lettered}; rolled back`);
  }
}

/**
 * Read, report and gate; with `apply`, also write. Prints the same report in both modes. Under `apply` all of it runs
 * in one transaction that locks the candidate slots and their artists, so a rename or refile racing the run cannot
 * slip between the gate and the write. A gate failure there writes nothing, and the transaction simply commits empty.
 */
async function evaluate(sql: Db, options: BackfillOptions, log: (line: string) => void): Promise<BackfillResult> {
  const { schema, apply, legacyReleases } = options;
  const candidates = [...(await findCandidates(sql, schema, apply))];
  log(`[comp-letter-backfill] ${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} candidate slots`);
  for (const c of candidates) {
    log(
      `  ${c.genre_name.padEnd(11)} ${c.letter}  ${String(c.artist_id).padStart(6)}  ${c.artist_name}  (now: ${c.code_comp_letter ?? 'NULL'})`
    );
  }

  const uncovered = await findUncovered(sql, schema);
  log(`[comp-letter-backfill] Rock/Soundtracks V/A slots not lettered: ${uncovered.length}`);
  for (const u of uncovered)
    log(`  ${u.genre_name.padEnd(11)}    ${String(u.artist_id).padStart(6)}  ${u.artist_name}`);

  let crossCheckResult: CrossCheckResult | null = null;
  if (legacyReleases) {
    crossCheckResult = crossCheck(candidates, [...(await findSlotReleases(sql, schema))], legacyReleases);
    const { agreed, disagreements, notInDump, backendMinted } = crossCheckResult;
    log(
      `[comp-letter-backfill] advisory cross-check vs frozen tubafrenzy: ${agreed} agree, ${disagreements.length} ` +
        `disagree, ${notInDump} not in dump, ${backendMinted} filed since the cutover (not checkable)`
    );
    for (const d of disagreements) {
      log(
        `  ${d.genre_name.padEnd(11)} ${d.letter}  ${String(d.artist_id).padStart(6)}  legacy release ${d.legacy_release_id} was ${describeFiling(d.legacy_call_letters, d.legacy_genre_id)}`
      );
    }
  } else {
    log('[comp-letter-backfill] advisory cross-check skipped: no --dump given');
  }

  const { failures, alreadyApplied } = checkGate(candidates, [...(await findLettered(sql, schema))]);
  const result = (status: Status): BackfillResult => ({ status, failures, candidates, crossCheck: crossCheckResult });
  if (failures.length > 0) {
    log('[comp-letter-backfill] GATE FAILED, nothing written:');
    for (const f of failures) log(`  ✗ ${f}`);
    return result('aborted');
  }
  if (alreadyApplied) {
    log(`[comp-letter-backfill] all ${EXPECTED_TOTAL} slots already carry their letter; nothing to do`);
    return result('already-applied');
  }
  if (!apply) {
    log('[comp-letter-backfill] gate passed; dry run, nothing written. Re-run with --apply to write.');
    return result('dry-run');
  }
  await applyLetters(sql, schema, candidates);
  return result('applied');
}

/** Run the backfill. `ANALYZE` follows the commit, so an error from it comes after the letters have landed. */
export async function runBackfill(sql: Sql, options: BackfillOptions): Promise<BackfillResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!options.apply) return evaluate(sql, options, log);

  const result = await sql.begin((tx) => evaluate(tx, options, log));
  if (result.status === 'applied') {
    log(`[comp-letter-backfill] COMMITTED ${EXPECTED_TOTAL} letters; running ANALYZE`);
    await sql`ANALYZE ${sql(options.schema)}.genre_artist_crossreference`;
    log('[comp-letter-backfill] ANALYZE done');
  }
  return result;
}
