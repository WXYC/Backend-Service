/**
 * The re-ask's three input files, and the admission rule (BS#3141). Pure — no
 * database, no network; the caller reads the bytes.
 *
 * Backend cannot read LML's pins, so they arrive as files (plan, "Where the
 * pin comes from"): the pin export, step 2's removal file, and the offline
 * grading manifest (decision 2). Nothing can cross-check them at run time, so
 * parsing is strict: the exact header, one value per column, and a refusal on
 * any line that does not parse. An empty required value is an error, never a
 * default. The only tolerated variations are a leading byte-order mark, CRLF
 * line endings and a missing final newline. No value these files carry
 * contains a comma, so quoting is not supported and a quoted value refuses.
 *
 * @see WXYC/Backend-Service#3137
 */

import { createHash } from 'crypto';

/** The grading manifest's closed tier vocabulary (plan, "Grading the pin"). */
export const TIERS = ['rebind', 'hold_stored_better', 'hold_ungradeable', 'hold_manual'] as const;
export type Tier = (typeof TIERS)[number];

/** A malformed input file. The message names the file, and the line where there is one. */
export class InputFileError extends Error {
  constructor(file: string, message: string, line?: number) {
    super(`${file}${line === undefined ? '' : ` line ${line}`}: ${message}`);
    this.name = 'InputFileError';
  }
}

/** One column's parser: the raw cell in, the value out, or a thrown message. */
type Cell<T> = (raw: string) => T;
type Columns = Record<string, Cell<unknown>>;
type RowOf<C extends Columns> = { [K in keyof C]: ReturnType<C[K]> };

const INTEGER = /^\d+$/;
// Unsigned decimal digits; `Number` then refuses a malformed one such as
// `1.2.3` (and this refuses the forms `Number` would accept, such as `1e3`,
// `0x10` or a negative sentinel). Grades and rates are never negative.
const DECIMAL = /^[\d.]+$/;
// `\copy` output for a timestamptz, e.g. `2026-10-14 09:53:12.123456-07`: the
// date and time, then any fraction and offset.
const TIMESTAMP = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d[\d.:+\-Z]*$/;

const nonNegativeInt: Cell<number> = (raw) => {
  const value = Number(raw);
  if (!INTEGER.test(raw) || !Number.isSafeInteger(value)) throw new Error(`not an integer: '${raw}'`);
  return value;
};

/** Every id in these files is positive: Discogs release ids start at 1, as do catalog ids. */
const id: Cell<number> = (raw) => {
  const value = nonNegativeInt(raw);
  if (value <= 0) throw new Error(`must be > 0, got ${value}`);
  return value;
};

// A padded source (`alex-l-2026 `) would silently miss the exact-match exception in `admit`.
const text: Cell<string> = (raw) => {
  if (raw === '') throw new Error('empty');
  if (raw.trim() !== raw) throw new Error(`surrounding whitespace in '${raw}'`);
  return raw;
};

const timestamp: Cell<string> = (raw) => {
  if (!TIMESTAMP.test(raw)) throw new Error(`not a timestamp: '${raw}'`);
  return raw;
};

const decimal: Cell<number> = (raw) => {
  const value = Number(raw);
  if (!DECIMAL.test(raw) || !Number.isFinite(value)) throw new Error(`not a number: '${raw}'`);
  return value;
};

const tier: Cell<Tier> = (raw) => {
  if (!(TIERS as readonly string[]).includes(raw)) throw new Error(`unknown tier '${raw}'`);
  return raw as Tier;
};

/** Empty means "none" (an ungradeable axis, a tier-2a card); anything else must parse. */
const optional =
  <T>(cell: Cell<T>): Cell<T | null> =>
  (raw) =>
    raw === '' ? null : cell(raw);

const PIN_COLUMNS = { library_id: id, discogs_release_id: id, source: text, updated_at: timestamp };
const REMOVAL_COLUMNS = { library_id: id, discogs_release_id: id, source: text };
const MANIFEST_COLUMNS = {
  library_id: id,
  stored_release_id: id,
  pin_release_id: id,
  pin_source: text,
  // Title axis: LML's `score_match` of each release's title against the card.
  stored_title_score: optional(decimal),
  pin_title_score: optional(decimal),
  // Play axis: the share of evidence plays found on each tracklist; empty when ungradeable.
  stored_play_rate: optional(decimal),
  pin_play_rate: optional(decimal),
  excluded_other_plays: nonNegativeInt,
  excluded_inferred_plays: nonNegativeInt,
  tier,
  // `pin_removed` rows only: step 2's play-corroborated release; empty for a tier-2a card.
  expected_release_id: optional(id),
};

/** A pin from `lml_cache.library_release_override`. `library_id` is Backend's `library.legacy_release_id`. */
export type PinRow = RowOf<typeof PIN_COLUMNS>;
/** A pin step 2 removed, from the card that has no pin now. */
export type RemovalRow = RowOf<typeof REMOVAL_COLUMNS>;
/** One graded card of the grading manifest. */
export type ManifestEntry = RowOf<typeof MANIFEST_COLUMNS>;

/** A validated input file. `sha256` covers the bytes as given, so a run log names the exact file. */
export interface InputFile<T> {
  rows: T[];
  byLibraryId: ReadonlyMap<number, T>;
  sha256: string;
}

// `fatal`: a file that is not UTF-8 (a spreadsheet's Latin-1 round trip) refuses
// rather than decoding to U+FFFD. The decoder also drops a leading BOM.
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const decode = (file: string, raw: Buffer): string => {
  try {
    return UTF8.decode(raw);
  } catch {
    throw new InputFileError(file, 'not valid UTF-8');
  }
};

const parseFile = <C extends Columns & { library_id: Cell<number> }>(
  file: string,
  columns: C,
  raw: Buffer,
  { allowEmpty }: { allowEmpty: boolean }
): InputFile<RowOf<C>> => {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const lines = decode(file, raw).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const parsers = Object.entries(columns);
  const names = parsers.map(([name]) => name);
  const header = names.join(',');
  if (lines[0] !== header) throw new InputFileError(file, `header must be exactly '${header}'`, 1);

  const rows: RowOf<C>[] = [];
  const byLibraryId = new Map<number, RowOf<C>>();
  lines.slice(1).forEach((line, index) => {
    const lineNo = index + 2;
    // Checked before the split, so a quoted value holding a comma is named as such.
    if (line.includes('"')) throw new InputFileError(file, 'quoted values are not supported', lineNo);
    const cells = line.split(',');
    if (cells.length !== names.length) {
      throw new InputFileError(file, `expected ${names.length} columns, got ${cells.length}`, lineNo);
    }

    const row = Object.fromEntries(
      parsers.map(([name, cell], i) => {
        try {
          return [name, cell(cells.at(i) ?? '')];
        } catch (err) {
          throw new InputFileError(file, `${name}: ${(err as Error).message}`, lineNo);
        }
      })
    ) as RowOf<C>;

    if (byLibraryId.has(row.library_id)) {
      throw new InputFileError(file, `duplicate library_id ${row.library_id}`, lineNo);
    }
    byLibraryId.set(row.library_id, row);
    rows.push(row);
  });

  if (rows.length === 0 && !allowEmpty) throw new InputFileError(file, 'no rows after the header');
  return { rows, byLibraryId, sha256 };
};

// A header-only pin export or manifest means the export went wrong (another
// database, another schema), never "nothing to do", so both refuse it. A
// removal file may be empty: a later run can follow no removals at all.
export const parsePinFile = (raw: Buffer): InputFile<PinRow> =>
  parseFile('pin file', PIN_COLUMNS, raw, { allowEmpty: false });

export const parseRemovalFile = (raw: Buffer): InputFile<RemovalRow> =>
  parseFile('removal file', REMOVAL_COLUMNS, raw, { allowEmpty: true });

export const parseGradingManifest = (raw: Buffer): InputFile<ManifestEntry> =>
  parseFile('grading manifest', MANIFEST_COLUMNS, raw, { allowEmpty: false });

/**
 * Why a cohort row is not asked. `hold_unmanifested`: its card is not in the
 * manifest. `hold_manifest_stale`: the manifest graded other releases than the
 * row now has, so its tier does not describe this row. `hold_restored`: a
 * restore put the album back (BS#3148).
 */
export type HoldReason = Exclude<Tier, 'rebind'> | 'hold_unmanifested' | 'hold_manifest_stale' | 'hold_restored';

/** The cohort row fields admission reads. A `pin_removed` row stores the removed release and has no pin. */
export interface AdmissionRow {
  legacy_release_id: number;
  reason: 'pin_mismatch' | 'pin_removed';
  stored_release_id: number | null;
  pin_release_id: number | null;
  /** A restore put this album back. */
  restored: boolean;
}

export type Admission = { ask: true; entry: ManifestEntry } | { ask: false; hold: HoldReason };

/** The one pin source whose ungradeable cards are asked anyway (decision 2). */
const UNGRADEABLE_EXCEPTION_SOURCE = 'alex-l-2026';

/**
 * Whether a cohort row may be asked (decision 2). The one place this rule
 * lives, so the dry run reports exactly what the execute loop will ask.
 *
 * - `pin_mismatch`: asked if the tier is `rebind`, or `hold_ungradeable` with
 *   pin source exactly `alex-l-2026`; held under its tier otherwise.
 * - `pin_removed`: asked unless the tier is `hold_manual` (card 29757).
 * - A card missing from the manifest is held as `hold_unmanifested`, and a card
 *   whose manifest entry graded other releases (the stored release, or the
 *   pin: the current one, or for `pin_removed` the removed one) is held as
 *   `hold_manifest_stale`. So a manifest built from another pin export can
 *   admit a card neither by omission nor by inclusion.
 * - A restored album is held as `hold_restored` before anything else, unless
 *   `includeRestored` (`REASK_INCLUDE_RESTORED=1`) lifts the hold.
 */
export const admit = (
  row: AdmissionRow,
  manifest: ReadonlyMap<number, ManifestEntry>,
  includeRestored = false
): Admission => {
  if (row.restored && !includeRestored) {
    return { ask: false, hold: 'hold_restored' };
  }
  const entry = manifest.get(row.legacy_release_id);
  if (!entry) return { ask: false, hold: 'hold_unmanifested' };

  const gradedPin = row.reason === 'pin_removed' ? row.stored_release_id : row.pin_release_id;
  if (entry.stored_release_id !== row.stored_release_id || entry.pin_release_id !== gradedPin) {
    return { ask: false, hold: 'hold_manifest_stale' };
  }

  if (row.reason === 'pin_removed') {
    return entry.tier === 'hold_manual' ? { ask: false, hold: 'hold_manual' } : { ask: true, entry };
  }
  if (entry.tier === 'rebind') return { ask: true, entry };
  if (entry.tier === 'hold_ungradeable' && entry.pin_source === UNGRADEABLE_EXCEPTION_SOURCE) {
    return { ask: true, entry };
  }
  return { ask: false, hold: entry.tier };
};
