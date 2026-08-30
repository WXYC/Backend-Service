/**
 * Review CSV round trip (BS#2319 step 5). No external CSV dependency --
 * eleven fixed columns don't earn one, and a hand-rolled RFC4180-ish
 * encode/decode is easy to keep correct for the one hazard that matters
 * here: artist/album titles routinely carry commas.
 *
 * `--export <path>` writes one row per `needs_review` asset: asset id, the
 * raw tags the bind decision was made against, the proposed library id +
 * artist/title, `bind_note`, and which content prefix it came from. Two
 * columns are the reviewer's to fill: `decision` (`bound` | `rejected`) and
 * `note`. `--import <path>` reads exactly those two columns back; every
 * other value is round-tripped for the reviewer's benefit only and is never
 * re-read as an instruction -- the library id, tags, etc. are not
 * reassignable via the CSV, only accept/reject.
 *
 * Any `decision` value other than exactly `bound` or `rejected` (case- and
 * whitespace-sensitive: blank, `maybe`, a stray typo) is a no-op row -- the
 * whole point of a CSV review is that "not yet decided" is the default, and
 * a fuzzy decision parser would risk silently transitioning a row the
 * reviewer never actually looked at.
 */

const COLUMNS = [
  'asset_id',
  'library_id',
  'disc_number',
  'provenance',
  'content_kind',
  'bind_note',
  'proposed_artist',
  'proposed_album_title',
  'tag_artist',
  'tag_album',
  'object_keys',
  'decision',
  'note',
] as const;

export interface ReviewRow {
  assetId: number;
  libraryId: number;
  discNumber: number;
  provenance: string;
  contentKind: string;
  bindNote: string;
  proposedArtist: string;
  proposedAlbumTitle: string;
  tagArtist: string;
  tagAlbum: string;
  objectKeys: string[];
}

export interface ReviewDecision {
  assetId: number;
  decision: 'bound' | 'rejected';
  note: string;
}

const OBJECT_KEY_SEPARATOR = '; ';

const csvField = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const exportReviewCsv = (rows: readonly ReviewRow[]): string => {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    const cells = [
      String(row.assetId),
      String(row.libraryId),
      String(row.discNumber),
      row.provenance,
      row.contentKind,
      row.bindNote,
      row.proposedArtist,
      row.proposedAlbumTitle,
      row.tagArtist,
      row.tagAlbum,
      row.objectKeys.join(OBJECT_KEY_SEPARATOR),
      '', // decision -- the reviewer's to fill
      '', // note -- the reviewer's to fill
    ];
    lines.push(cells.map(csvField).join(','));
  }
  return lines.join('\n');
};

/** One logical CSV row -> its raw string cells, honoring quoted commas/newlines. */
const parseCsvRows = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
};

export const importReviewCsv = (csvText: string): ReviewDecision[] => {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) return [];

  const header = rows[0];
  const assetIdIdx = header.indexOf('asset_id');
  const decisionIdx = header.indexOf('decision');
  const noteIdx = header.indexOf('note');
  if (assetIdIdx === -1 || decisionIdx === -1) return [];

  const decisions: ReviewDecision[] = [];
  for (const cells of rows.slice(1)) {
    const rawDecision = cells[decisionIdx];
    if (rawDecision !== 'bound' && rawDecision !== 'rejected') continue;

    const assetId = Number.parseInt(cells[assetIdIdx], 10);
    if (!Number.isInteger(assetId)) continue;

    decisions.push({ assetId, decision: rawDecision, note: noteIdx === -1 ? '' : (cells[noteIdx] ?? '') });
  }
  return decisions;
};
