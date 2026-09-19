/**
 * Reads a `catalog_delete_snapshot.captured` envelope (BS#2561 / F2a). Free
 * of DB and HTTP concerns on purpose: `GET /library/deleted`
 * (`library.service.ts`) is its first consumer and WXYC/Backend-Service#2585
 * (the restore endpoint) is its second, and neither of those belongs to the
 * other's package. Deliberately consumer-agnostic — this module has no
 * opinion about listing pagination/projection or restore semantics, only
 * about the envelope's shape, so a change either consumer needs stays in
 * that consumer, not here.
 */

/** The two-namespace shape `captureCatalogDeleteSnapshot` writes — see its docstring in `catalog-delete-snapshot.ts`. */
export type CapturedEnvelope = {
  entity: { table: string; row: Record<string, unknown> | null };
  children: Record<string, unknown[]>;
};

/**
 * `captured` reads back as `unknown` (plain `jsonb`, no `$type<...>()` on the
 * column) — this narrows it. Never throws: a malformed value reads as an
 * empty envelope rather than taking the listing down, because every row this
 * function sees was written by `captureCatalogDeleteSnapshot` and a shape
 * this defensive can only ever paper over a bug it should instead surface —
 * but surfacing it is one 500 for one archive row, not a reason to 500 the
 * whole page.
 *
 * Every field is TYPE-CHECKED, not merely narrowed by a cast — a
 * wrong-typed value falls back to the same default a missing one gets,
 * rather than passing through under `as`. `entity.table` falls back to `''`
 * on anything but a `string`. `entity.row` falls back to `null` on anything
 * but a plain object (a `string`, `number`, or array reads as "no row").
 * `children` falls back to `{}` on anything but a plain object, and each
 * VALUE inside it that isn't an array falls back to `[]` in turn — so
 * `parseCapturedEnvelope(x).children[table]` is always a real array the
 * caller can safely `.length`/iterate, never a value that merely satisfies
 * the type by assertion. This module is a shared seam
 * (WXYC/Backend-Service#2585 is its second consumer, see the module
 * docstring above) — its declared return type is a contract a second
 * consumer is expected to trust without re-checking.
 */
export function parseCapturedEnvelope(captured: unknown): CapturedEnvelope {
  const envelope = (captured ?? {}) as { entity?: { table?: unknown; row?: unknown }; children?: unknown };
  const table = typeof envelope.entity?.table === 'string' ? envelope.entity.table : '';
  const row = isPlainRecord(envelope.entity?.row) ? envelope.entity?.row : null;
  const rawChildren = isPlainRecord(envelope.children) ? envelope.children : {};
  const children = Object.fromEntries(
    Object.entries(rawChildren).map(([key, value]) => [key, Array.isArray(value) ? value : []])
  );
  return { entity: { table, row }, children };
}

/**
 * A JSON "object" in the narrow sense this module needs: excludes `null`
 * (`typeof null === 'object'`) and excludes arrays (also `typeof ===
 * 'object'`, but never what `entity.row` or `children` mean here — a row is
 * a record of columns, not a list).
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parent-before-child precedence for the entities in one batch. `library`
 * references `artists.id`, so an artist entity (WXYC/Backend-Service#2562 —
 * not shipped yet, every batch today holds exactly one `library` entity)
 * orders ahead of a library one. A kind absent from this list sorts last
 * rather than throwing, so an entity_kind this module doesn't yet know about
 * still renders (at the end) instead of dropping the batch.
 */
const ENTITY_KIND_PRECEDENCE = ['artist', 'library'];

/**
 * Sorts a batch's snapshot rows parent-before-children (see
 * `ENTITY_KIND_PRECEDENCE`), tiebreaking same-kind rows by ascending `id` for
 * a stable, deterministic order. Generic over just the two fields it reads,
 * rather than importing `CatalogDeleteSnapshot`, so this module never needs
 * to import `schema.ts` and the restore consumer can hand it whatever
 * partial row shape it already has in memory.
 */
export function orderBatchEntities<T extends { entity_kind: string; id: number }>(rows: T[]): T[] {
  const rank = (kind: string): number => {
    const index = ENTITY_KIND_PRECEDENCE.indexOf(kind);
    return index === -1 ? ENTITY_KIND_PRECEDENCE.length : index;
  };
  return [...rows].sort((a, b) => rank(a.entity_kind) - rank(b.entity_kind) || a.id - b.id);
}

/**
 * The five dependents no envelope ever captures (BS#2561 issue body): four
 * are derived and rebuilt by their own jobs, and `album_review_submissions`
 * is `ON DELETE SET NULL` (nothing was lost) with a `reviewer_raw` column
 * that is PII behind ADR 0011's projection barrier. A restore of a batch
 * cannot bring these back, and a listing that stayed silent about them would
 * read as a lossless-restore promise it can't keep.
 */
export const UNRECOVERABLE_DEPENDENTS = [
  'album_metadata',
  'library_identity',
  'library_identity_source',
  'uncovered_release_search_markers',
  'album_review_submissions',
] as const;
