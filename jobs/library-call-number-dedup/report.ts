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
 * execute run would.
 */

/** One line of shelf work: pull this disc, cross out its number, write the new one. */
export interface RelabelItem {
  genre: string;
  artist: string;
  codeLetters: string;
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
  title: string;
  atNumber: number;
  reason: string;
}

const callNumber = (letters: string, n: number, vol: string): string =>
  vol ? `${letters} ${n} ${vol}` : `${letters} ${n}`;

/** Render the worklist as Markdown, grouped by genre then shelf. */
export const formatWorklist = (items: readonly RelabelItem[], held: readonly HeldItem[]): string => {
  const genres = [...new Set(items.map((i) => i.genre))].sort();
  const out: string[] = [];

  out.push('# Call-number relabel worklist');
  out.push('');
  out.push(
    'Each row below is a shelf slot that held two different releases under one call number. The catalog now gives one of them a new number; **the disc itself still carries the old one.** Until it is relabelled the shelf and the catalog disagree.'
  );
  out.push('');
  out.push(
    'For each row: pull the disc under **Relabel this one**, cross out its number, write the new one, and refile it in number order. The other disc in the slot keeps its number and does not move.'
  );
  out.push('');
  out.push(
    `**${items.length} ${items.length === 1 ? 'disc' : 'discs'} to relabel**` +
      (genres.length ? ` across ${genres.length} ${genres.length === 1 ? 'genre' : 'genres'}` : '') +
      (held.length ? `, plus **${held.length} that need your judgement** (last section).` : '.')
  );
  out.push('');
  out.push('| ✓ | Genre | Shelf | Relabel this one | Was | Becomes | Stays put |');
  out.push('|---|---|---|---|---|---|---|');
  for (const genre of genres) {
    const rows = items
      .filter((i) => i.genre === genre)
      .sort((a, b) => a.codeLetters.localeCompare(b.codeLetters) || a.oldNumber - b.oldNumber);
    for (const i of rows) {
      out.push(
        `| ☐ | ${genre} | ${i.artist} | ${i.moveTitle} | \`${callNumber(i.codeLetters, i.oldNumber, i.vol)}\` | ` +
          `\`${callNumber(i.codeLetters, i.newNumber, i.vol)}\` | ${i.keepTitle} |`
      );
    }
  }
  out.push('');

  if (held.length > 0) {
    out.push('## Needs your judgement');
    out.push('');
    out.push(
      'In these, the disc that would have moved **already has a same-titled copy elsewhere on the same shelf.** Giving it a new number would leave one title at three addresses. Whether the other copy is a genuine duplicate, a different pressing, or a mis-filing is a question the shelf can answer and the database cannot, so nothing was changed.'
    );
    out.push('');
    out.push('| Genre | Shelf | Title | Currently at | Why it was held |');
    out.push('|---|---|---|---|---|');
    for (const h of held) {
      out.push(
        `| ${h.genre} | ${h.artist} | ${h.title} | \`${callNumber(h.codeLetters, h.atNumber, '')}\` | ${h.reason} |`
      );
    }
    out.push('');
  }
  return out.join('\n');
};
