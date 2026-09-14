/**
 * The nested `card` wire field on catalog search rows (BS#2476).
 *
 * Single source of truth for BOTH catalog search read paths (BS#2231's
 * consolidation): `serializeLibraryArtistViewEntry` (GET /library and its
 * sibling read surfaces, library.service.ts) and the `AlbumSearchResultRow`
 * mappers (GET /library/query, library-search.service.ts) build `card` here,
 * from the same four flat columns, so the two surfaces cannot drift on what
 * counts as a card or which row it names.
 */

/**
 * A row that carries the four flat card columns from the active-rotation
 * `rotation_cards` LEFT JOIN — `library_artist_view`, or any projection over
 * `LIBRARY_VIEW_PROJECTION`. All four ride the same CURRENT_DATE-filtered
 * `rotation` JOIN that populates `rotation_bin`, so they are non-null only
 * while the row is actively rotating.
 */
export type RotationCardSource = {
  card_id: number | null;
  card_bin: string | null;
  card_number: number | null;
  card_name: string | null;
};

/** Wire shape of the nested `card` object (wxyc-shared's `RotationCard`). */
export type RotationCardWire = { id: number; bin: string; number: number; name: string | null };

/**
 * Build the nested `card` wire field from the flat card columns, or null when
 * the row is not actively rotating (or its rotation row has no card assigned).
 *
 * `bin` is the card's own `rotation_cards.bin`, never the rotation row's
 * `rotation_bin`: their equality is enforced at the service layer only
 * (BS#2472, no DB constraint), and a read that derived one from the other
 * would silently mask a violating row instead of surfacing it.
 */
export function buildCard(row: RotationCardSource): RotationCardWire | null {
  if (row.card_id === null || row.card_bin === null || row.card_number === null) return null;
  return { id: row.card_id, bin: row.card_bin, number: row.card_number, name: row.card_name };
}

/**
 * Strip the four flat card columns — undeclared in wxyc-shared's api.yaml —
 * and replace them with the nested `card` object the contract declares on
 * AlbumSearchResult.
 */
export function withRotationCard<T extends RotationCardSource>(
  row: T
): Omit<T, keyof RotationCardSource> & { card: RotationCardWire | null } {
  const { card_id, card_bin, card_number, card_name, ...rest } = row;
  return { ...rest, card: buildCard({ card_id, card_bin, card_number, card_name }) };
}
