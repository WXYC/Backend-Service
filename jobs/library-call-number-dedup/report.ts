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
        `| ☐ | ${genre} | ${i.artist} | ${i.moveTitle} | \`${callNumber(i.codeLetters, i.artistGenreCode, i.oldNumber, i.vol)}\` | ` +
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
  return out.join('\n');
};
