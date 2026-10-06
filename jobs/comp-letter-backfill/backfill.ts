/**
 * Importable core of the one-shot comp-letter backfill (BS#2834, epic BS#2828).
 *
 * Fills `genre_artist_crossreference.code_comp_letter` on the 52 Rock/Soundtracks compilation slots: 26
 * `Various Artists - Rock - <L>` sections and 26 `Soundtracks - <L>` sections. Until now the letter has existed only
 * as the trailing ` - <L>` of the slot's artist name, so that is where it is read from — once, here, behind a gate.
 *
 * The gate is what makes reading a name safe. Each genre must come out as exactly A-Z with no gaps and no repeats, so
 * a section renamed since the cutover aborts the whole run instead of going quietly unlettered. Nothing is written
 * unless every check passes, and a set value is never overwritten.
 *
 * Takes the postgres.js handle from its caller and imports nothing at runtime, so the integration spec can run this
 * exact module (`dist/backfill.cjs`) against a real Postgres with its own pool.
 */

import type { Sql } from 'postgres';

/** One candidate slot, with the letter read from its name and whatever letter it already carries. */
export interface Candidate {
  artist_id: number;
  genre_id: number;
  genre_name: string;
  artist_name: string;
  letter: string;
  code_comp_letter: string | null;
}

export type Status = 'dry-run' | 'applied' | 'already-applied' | 'aborted';

export interface BackfillResult {
  status: Status;
  failures: string[];
  candidates: Candidate[];
}

export interface BackfillOptions {
  schema: string;
  apply: boolean;
  log?: (line: string) => void;
}

const GENRES = ['Rock', 'Soundtracks'] as const;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const EXPECTED_TOTAL = GENRES.length * ALPHABET.length;

/**
 * The candidate set exactly as BS#2834 specifies it, plus the slot's current letter. Every condition is structural
 * except the trailing ` - <letter>`, which is the only place the letter exists today.
 */
export const findCandidates = (sql: Sql, schema: string) => sql<Candidate[]>`
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
`;

/** Rock/Soundtracks `V/A` slots the candidate predicate leaves out. Expected: the catch-all's Soundtracks filing. */
const findUncovered = (sql: Sql, schema: string) => sql<
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
 * Decide whether the write may run. `alreadyApplied` is a completed earlier run — every slot carries exactly the
 * letter its name gives — which makes a re-run a no-op rather than a failure. Any other set value is a failure.
 */
export function checkGate(candidates: Candidate[]): { failures: string[]; alreadyApplied: boolean } {
  const failures: string[] = [];
  if (candidates.length !== EXPECTED_TOTAL) {
    failures.push(`expected ${EXPECTED_TOTAL} candidate slots, found ${candidates.length}`);
  }
  for (const genre of GENRES) {
    const letters = candidates.filter((c) => c.genre_name === genre).map((c) => c.letter);
    if (letters.length !== ALPHABET.length) {
      failures.push(`${genre}: expected ${ALPHABET.length} slots, found ${letters.length}`);
    }
    const missing = ALPHABET.filter((l) => !letters.includes(l));
    const duplicates = [...new Set(letters.filter((l, i) => letters.indexOf(l) !== i))];
    if (missing.length > 0) failures.push(`${genre}: missing ${missing.join(', ')}`);
    if (duplicates.length > 0) failures.push(`${genre}: duplicate ${duplicates.join(', ')}`);
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
 * Write the 52 letters in one transaction, one bound UPDATE per slot, each guarded `code_comp_letter IS NULL` and
 * required to touch exactly one row. Before commit, the table must hold exactly 52 letters in total, so a run can
 * never leave any other row lettered.
 */
async function applyLetters(sql: Sql, schema: string, candidates: Candidate[]): Promise<void> {
  await sql.begin(async (tx) => {
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
  });
  await sql`ANALYZE ${sql(schema)}.genre_artist_crossreference`;
}

/** Report, gate, and (with `apply`) write. Prints the same report in both modes. */
export async function runBackfill(sql: Sql, options: BackfillOptions): Promise<BackfillResult> {
  const { schema, apply } = options;
  const log = options.log ?? ((line: string) => console.log(line));

  const candidates = [...(await findCandidates(sql, schema))];
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

  const { failures, alreadyApplied } = checkGate(candidates);
  const result = (status: Status): BackfillResult => ({ status, failures, candidates });
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
  log(`[comp-letter-backfill] wrote ${EXPECTED_TOTAL} letters and ran ANALYZE`);
  return result('applied');
}
