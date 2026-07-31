/**
 * The pluggable "authoritative live keyspace" seam (BS#1887).
 *
 * The sweep needs to know which `legacy_entry_id` / `legacy_rotation_id`
 * values still exist upstream so it can anti-join Backend's rows against
 * them and flag the residual as ghosts. How that keyspace gets extracted
 * from the final tubafrenzy `mysqldump` — SSH mirror, restored MySQL,
 * extracted id file, something else — is undecided and owned by BS#1083 /
 * BS#1543 (the parent issue's "run and close" gate), not this issue. This
 * interface is the seam that lets the sweep mechanism be built and tested
 * now, independent of that decision.
 *
 * `FileKeyspaceSource` is the only implementation this package ships: a
 * newline-delimited integer id file per table, produced by whatever
 * preprocessing step BS#1083 ends up writing to turn the dump into an id
 * list. That keeps this package decoupled from the dump format entirely —
 * it never parses SQL, never talks to MySQL, and the same file-backed
 * adapter that exercises the sweep in tests is exactly what a human
 * operator would point at a real extracted id file for the BS#1083 prod
 * run. A prod adapter that reads the dump (or a live mirror) directly is a
 * *documented seam*, not a stub shipped here — add a new
 * `LegacyKeyspaceSource` implementation in BS#1083 once the extraction
 * mechanism is decided; `orchestrate.ts` takes the interface, not a
 * concrete class, so no sweep code changes.
 */

import { readFile } from 'node:fs/promises';

export interface LegacyKeyspaceSource {
  /** The set of `legacy_entry_id` values that still exist upstream (tubafrenzy `FLOWSHEET`). */
  loadFlowsheetIds(): Promise<Set<number>>;
  /** The set of `legacy_rotation_id` values that still exist upstream (tubafrenzy `ROTATION_RELEASE`). */
  loadRotationIds(): Promise<Set<number>>;
}

/**
 * Parse a newline-delimited list of integer ids. Blank lines and
 * `#`-prefixed comment lines are skipped so an operator can hand-annotate
 * an extracted id file. A non-blank, non-comment line that isn't a bare
 * positive integer within the `legacy_entry_id` / `legacy_rotation_id`
 * column's range (a positive 32-bit int) is a malformed extraction and fails
 * loudly rather than silently dropping. The range check matters as much as
 * the digit check: an out-of-range value like `99999999999999999999` passes
 * a bare `\d+` test but `Number()`s to an *imprecise* float that would never
 * match a real row's id — silently converting one corrupt line into a false
 * membership miss (and, at scale, false ghosts) — exactly the silent-membership
 * corruption this parser exists to prevent.
 */
/** `legacy_entry_id` / `legacy_rotation_id` are PostgreSQL `integer` (int4); this is their max. */
const MAX_LEGACY_ID = 2_147_483_647;

export const parseIdFile = (contents: string, sourceLabel: string): Set<number> => {
  const ids = new Set<number>();
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!/^\d+$/.test(line)) {
      throw new Error(`${sourceLabel}:${i + 1}: expected a positive integer id, got ${JSON.stringify(line)}`);
    }
    const id = Number(line);
    if (id < 1 || id > MAX_LEGACY_ID) {
      throw new Error(
        `${sourceLabel}:${i + 1}: id ${JSON.stringify(line)} is outside the supported range 1..${MAX_LEGACY_ID} ` +
          '(legacy_entry_id / legacy_rotation_id are positive 32-bit integers)'
      );
    }
    ids.add(id);
  }
  return ids;
};

export class FileKeyspaceSource implements LegacyKeyspaceSource {
  constructor(
    private readonly flowsheetIdsPath: string,
    private readonly rotationIdsPath: string
  ) {}

  async loadFlowsheetIds(): Promise<Set<number>> {
    const contents = await readFile(this.flowsheetIdsPath, 'utf8');
    return parseIdFile(contents, this.flowsheetIdsPath);
  }

  async loadRotationIds(): Promise<Set<number>> {
    const contents = await readFile(this.rotationIdsPath, 'utf8');
    return parseIdFile(contents, this.rotationIdsPath);
  }
}
