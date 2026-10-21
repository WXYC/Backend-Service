/**
 * The rows of the first `albums` distinct ids in `rows`, in their order.
 *
 * Trims by album, never by row: an album's rotation fan-out rows share one
 * id, so a row slice could cut an album in half. Shared by Both-mode catalog
 * search (BS#3578) and the unit suite's SQL mock, so the two trim alike.
 *
 * @param rows Rows in page order.
 * @param albums How many albums to keep; not negative (clamp at the call site).
 * @param ids The distinct ids of `rows` in first-seen order, when the caller
 *   already has them. A `Set` keeps insertion order, so this is page order.
 * @returns `rows` itself when every album fits, else the kept rows.
 */
export function keepLeadingAlbums<T extends { id: number }>(
  rows: T[],
  albums: number,
  ids: ReadonlySet<number> = new Set(rows.map((r) => r.id))
): T[] {
  if (albums >= ids.size) {
    return rows;
  }
  const kept = new Set([...ids].slice(0, albums));
  return rows.filter((r) => kept.has(r.id));
}
