/**
 * Pure formatter for the librarian's relabel worklist.
 *
 * A renumber is only half a fix. The catalog row moves to a free number the
 * moment the job writes it, but the disc on the shelf still carries the old
 * one, so until someone relabels it the shelf and the catalog disagree — and
 * the uniqueness constraint this job exists to enable cannot be added until
 * they agree. This renders the list that closes that gap.
 *
 * Kept pure and separate from `merge.ts` so the output can be asserted in unit
 * tests without a database, and so a dry-run can produce the exact worklist an
 * execute run would — same rows, same numbers, so the plan can be reviewed
 * before it is approved.
 *
 * That property is also the hazard, which is why `mode` is a required argument
 * rather than an optional one. A dry-run worklist describes physical shelf work
 * against a catalog that has not moved: act on it and every relabelled disc
 * disagrees with its catalog row, which is the disagreement this job exists to
 * remove, in reverse. The document therefore has to say which run produced it,
 * and it has to say so in places that survive being forwarded, pasted without
 * its first paragraph, or printed — so the marking is in the title, a header
 * banner, every row of the table, and a footer, not in a single banner on top.
 */

/** One line of shelf work: pull this disc, cross out its number, write the new one. */
export interface RelabelItem {
  genre: string;
  artist: string;
  codeLetters: string;
  /** `genre_artist_crossreference.artist_genre_code` — the middle component. */
  artistGenreCode: number | null;
  moveTitle: string;
  keepTitle: string;
  oldNumber: number;
  newNumber: number;
  vol: string;
}

/** A renumber that was withheld because only the shelf can settle it. */
export interface HeldItem {
  genre: string;
  artist: string;
  codeLetters: string;
  artistGenreCode: number | null;
  title: string;
  atNumber: number;
  /** Volume letter of the slot, or '' — a held item can sit on a lettered shelf. */
  vol: string;
  reason: string;
}

/**
 * A WXYC call number has three components — code letters, the artist's number
 * within the genre, and the release's number on that shelf — plus a volume
 * letter for a multi-disc set. Two artists in one genre routinely share code
 * letters, so dropping the middle component yields an address that does not
 * identify a slot. Rendered space-separated, matching the three fields the
 * catalog API returns rather than inventing a punctuation convention.
 */
const callNumber = (letters: string, artistGenreCode: number | null, n: number, vol: string): string => {
  const parts = [letters, artistGenreCode === null ? null : String(artistGenreCode), String(n), vol || null];
  return parts.filter((p) => p !== null && p !== '').join(' ');
};

/**
 * Which run produced this document, and therefore whether it may be acted on.
 * Required, not defaulted: the unmarked document is the dangerous one, so there
 * is no value a future call site can forget its way into.
 */
export type WorklistMode = 'dry-run' | 'execute';

/**
 * Header banner. States the hazard rather than just the mode, because "dry run"
 * is jargon to the person holding the discs.
 */
const PREVIEW_HEADER =
  '> **PREVIEW OF A RUN THAT HAS NOT HAPPENED — DO NOT SEND THIS TO THE LIBRARIAN.** This came from a dry run. The job made no writes, so every catalog row still holds the call number it had before. Relabelling a disc from this list would put the shelf out of step with a catalog that never moved — the shelf/catalog disagreement this job exists to remove, in reverse. Only an `--execute` run produces a worklist that may be acted on.';

/**
 * Footer banner. Deliberately repeats the header rather than referring back to
 * it: the table is the part that gets forwarded on its own, and whoever receives
 * it that way has the footer and not the header.
 */
const PREVIEW_FOOTER =
  '> **End of PREVIEW — nothing above has happened.** Every call number in the "Would become" column is planned, not assigned, and is re-planned from scratch on each run. No catalog row has moved. Do not relabel any disc from this document, and do not forward it.';

/** Render the worklist as Markdown, grouped by genre then shelf. */
export const formatWorklist = (
  items: readonly RelabelItem[],
  held: readonly HeldItem[],
  mode: WorklistMode
): string => {
  const preview = mode === 'dry-run';
  const genres = [...new Set(items.map((i) => i.genre))].sort();
  const out: string[] = [];

  // The title is the closest thing this document has to a filename: it is what
  // a paste into a doc, an email subject, or a print header inherits.
  out.push(preview ? '# Call-number relabel worklist — PREVIEW, DO NOT DISTRIBUTE' : '# Call-number relabel worklist');
  out.push('');
  if (preview) {
    out.push(PREVIEW_HEADER);
    out.push('');
  }
  out.push(
    preview
      ? 'Each row below is a shelf slot that holds two different releases under one call number. An `--execute` run would give one of them a new number, after which **the disc itself would still carry the old one** and would need relabelling. That run has not been made.'
      : 'Each row below is a shelf slot that held two different releases under one call number. The catalog now gives one of them a new number; **the disc itself still carries the old one.** Until it is relabelled the shelf and the catalog disagree.'
  );
  out.push('');
  out.push(
    preview
      ? 'Nothing here is an instruction. It is the shelf work an `--execute` run would create if it ran now, shown so the plan can be reviewed before it is approved.'
      : 'For each row: pull the disc under **Relabel this one**, cross out its number, write the new one, and refile it in number order. The other disc in the slot keeps its number and does not move.'
  );
  out.push('');
  out.push(
    `**${items.length} ${items.length === 1 ? 'disc' : 'discs'} ${preview ? 'would need relabelling' : 'to relabel'}**` +
      (genres.length ? ` across ${genres.length} ${genres.length === 1 ? 'genre' : 'genres'}` : '') +
      (held.length
        ? `, plus **${held.length} that ${preview ? 'would need' : 'need'} your judgement** (last section).`
        : '.')
  );
  out.push('');
  out.push(
    preview
      ? '| ⚠ | Genre | Shelf | Would relabel this one | Was | Would become | Stays put |'
      : '| ✓ | Genre | Shelf | Relabel this one | Was | Becomes | Stays put |'
  );
  out.push('|---|---|---|---|---|---|---|');
  for (const genre of genres) {
    const rows = items
      .filter((i) => i.genre === genre)
      .sort((a, b) => a.codeLetters.localeCompare(b.codeLetters) || a.oldNumber - b.oldNumber);
    for (const i of rows) {
      // The check-off box becomes the word PREVIEW: a single row lifted out of
      // the table still carries the warning, and there is nothing to check off
      // on a run that has not happened.
      out.push(
        `| ${preview ? 'PREVIEW' : '☐'} | ${genre} | ${i.artist} | ${i.moveTitle} | \`${callNumber(i.codeLetters, i.artistGenreCode, i.oldNumber, i.vol)}\` | ` +
          `\`${callNumber(i.codeLetters, i.artistGenreCode, i.newNumber, i.vol)}\` | ${i.keepTitle} |`
      );
    }
  }
  out.push('');

  if (held.length > 0) {
    out.push('## Needs your judgement');
    out.push('');
    out.push(
      'These slots were left alone because the database cannot settle them. Either the disc that would have moved already has a same-titled copy elsewhere on the shelf — so a new number would leave one title at three addresses — or the slot still holds two different releases after its duplicates merged. Which copy is real, and which should move, is a question the shelf can answer and the catalog cannot. Nothing was changed.'
    );
    out.push('');
    out.push('| Genre | Shelf | Title | Currently at | Why it was held |');
    out.push('|---|---|---|---|---|');
    for (const h of held) {
      out.push(
        `| ${h.genre} | ${h.artist} | ${h.title} | \`${callNumber(h.codeLetters, h.artistGenreCode, h.atNumber, h.vol)}\` | ${h.reason} |`
      );
    }
    out.push('');
  }

  if (preview) {
    out.push(PREVIEW_FOOTER);
    out.push('');
  }
  return out.join('\n');
};
