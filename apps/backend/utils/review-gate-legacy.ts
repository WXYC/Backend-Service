import { isOnOrBeforeCutover } from './review-gate-cutover.js';

/** One rotation row as the legacy walk reads it; `add_date` is the stored `YYYY-MM-DD` (select `add_date::text`). */
export type RotationChainRow = {
  id: number;
  album_id: number | null;
  add_date: string;
  moved_from_rotation_id: number | null;
};

/**
 * Whether a rotation row is legacy (BS#2810): unlinked, and either added on or before the cutover date (any row
 * while the date is unset) or moved from a row that is. `chain` is the row plus its ancestors in any order. The walk
 * keeps a visited set, so a loop in the data ends it; a parent that is not in `chain` (deleted) breaks the line.
 */
export const isLegacyRotationRow = (chain: RotationChainRow[], rowId: number): boolean => {
  const byId = new Map(chain.map((row) => [row.id, row]));
  const seen = new Set<number>();
  let row = byId.get(rowId);
  while (row && !seen.has(row.id)) {
    if (row.album_id !== null) return false;
    if (isOnOrBeforeCutover(row.add_date)) return true;
    seen.add(row.id);
    row = row.moved_from_rotation_id === null ? undefined : byId.get(row.moved_from_rotation_id);
  }
  return false;
};
