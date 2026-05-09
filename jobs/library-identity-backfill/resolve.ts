/**
 * Source-1 resolver: Backend `library.canonical_entity_id` → per-source rows.
 *
 * This is sub-PR 2.0's only source leg. Rows in `library` whose
 * `canonical_entity_id` matches the `'discogs:<release_id>'` shape produce
 * exactly one per-source row (`source='discogs_release'`, `method='exact_match'`,
 * `confidence=1.00`). Sub-PRs 2.1-2.3 add more readers under `sources/`.
 *
 * The 1.00 + exact_match assignment is justified at plan §4 sub-PR 2.0:
 * `library.canonical_entity_id` is populated by the existing
 * `library-canonical-entity-backfill` job's "direct hit with release_id"
 * branch, which is the §3.4.1 `exact_match` definition (not name_variation,
 * not trigram). The historical `AUTO_ACCEPT_CONFIDENCE = 0.95` from that job
 * is a synth value for retroactive filtering, not an assertion that the
 * underlying match is below `exact_match` 1.00 — we re-stamp at the §3.4.1
 * canonical level here.
 *
 * Output is decision-only — the writer is responsible for inserting and
 * for stamping the `notes='backfill:S1'` tag (already pre-populated here so
 * the writer can pass it through unchanged).
 */

export type LibraryRow = {
  id: number;
  canonical_entity_id: string | null;
  canonical_entity_resolved_at: Date | null;
};

/**
 * One per-source row to insert into `library_identity_source`. Fields mirror
 * the substrate columns 1:1 except for the `library_id` PK component which
 * the writer fills in from the iteration cursor.
 */
export type SourceRowToWrite = {
  library_id: number;
  source: string;
  external_id: string;
  method: string;
  confidence: number;
  last_verified_at: Date;
  boost_sources: string | null;
  notes: string;
};

export type ResolveOutcome =
  | { status: 'match'; sourceRows: SourceRowToWrite[] }
  | { status: 'no_canonical_entity_id' }
  | { status: 'non_discogs_namespace' };

/** Tag used on the `notes` column so the §5.3 unwind can find S1 rows. */
export const NOTES_TAG_S1 = 'backfill:S1';

const DISCOGS_PREFIX = 'discogs:';

export const resolveS1 = (row: LibraryRow): ResolveOutcome => {
  if (row.canonical_entity_id == null) {
    return { status: 'no_canonical_entity_id' };
  }
  if (!row.canonical_entity_id.startsWith(DISCOGS_PREFIX)) {
    return { status: 'non_discogs_namespace' };
  }
  const idText = row.canonical_entity_id.slice(DISCOGS_PREFIX.length);
  // canonical_entity_id is opaque text in the schema, so a hand-edit could
  // technically write 'discogs:foo'. Reject anything that isn't a positive
  // integer rather than smuggling a non-integer through to PG.
  if (!/^[0-9]+$/.test(idText)) {
    return { status: 'non_discogs_namespace' };
  }

  const lastVerifiedAt = row.canonical_entity_resolved_at ?? new Date();

  return {
    status: 'match',
    sourceRows: [
      {
        library_id: row.id,
        source: 'discogs_release',
        external_id: idText,
        method: 'exact_match',
        confidence: 1.0,
        last_verified_at: lastVerifiedAt,
        boost_sources: null,
        notes: NOTES_TAG_S1,
      },
    ],
  };
};
