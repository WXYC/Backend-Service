/**
 * Forward-path LML linkage for newly inserted flowsheet rows (B-2.1).
 *
 * When `addEntry` writes a flowsheet row without `album_id`, this service is
 * fired-and-forgotten to resolve a canonical entity via LML and link the row
 * to its matching library album. The flow:
 *
 *   1. LML lookup on (artist, album) text.
 *   2. Map result to a (canonical_entity_id, confidence) pair via the same
 *      helper used by addAlbum (so library and flowsheet land on the same
 *      identifier scheme).
 *   3. Gate on AUTO_ACCEPT_THRESHOLD — only `search_type=direct` (≈0.9)
 *      auto-links per the B-0 calibration. `fallback` (≈0.5) goes to the
 *      manual review queue (B-3.1) once that ships; for now it returns
 *      low_confidence and the row stays NULL for B-2.2's sweep to retry.
 *   4. Resolve the canonical entity to library rows.
 *      - 0 rows → unmatched (canonical entity not in WXYC library).
 *      - 1 row  → link with `linkage_source='lml_high_confidence'`.
 *      - 2+ rows → defer to B-2.3 tie-break. Until B-2.3 lands, we leave the
 *        row unlinked rather than picking arbitrarily.
 */
import { eq } from 'drizzle-orm';
import { db, flowsheet, library } from '@wxyc/database';
import { lookupMetadata } from './lml/lml.client.js';
import { mapLookupToCanonicalEntity } from './library.service.js';

const AUTO_ACCEPT_THRESHOLD = 0.9;

export type LinkageOutcome =
  | { status: 'linked'; libraryId: number; canonicalEntityId: string; confidence: number }
  | { status: 'no_canonical_entity' }
  | { status: 'low_confidence'; canonicalEntityId: string; confidence: number }
  | { status: 'no_library_match'; canonicalEntityId: string; confidence: number }
  | { status: 'multi_match'; canonicalEntityId: string; confidence: number; libraryIds: number[] };

async function findLibraryRowsByCanonicalEntity(canonicalEntityId: string): Promise<{ id: number }[]> {
  return db.select({ id: library.id }).from(library).where(eq(library.canonical_entity_id, canonicalEntityId));
}

async function setFlowsheetLinkage(
  flowsheetId: number,
  libraryId: number,
  source: string,
  confidence: number
): Promise<void> {
  await db
    .update(flowsheet)
    .set({
      album_id: libraryId,
      linkage_source: source,
      linkage_confidence: confidence,
      linked_at: new Date(),
    })
    .where(eq(flowsheet.id, flowsheetId));
}

export async function runLmlLinkage(args: {
  flowsheetId: number;
  artistName: string;
  albumTitle: string | null | undefined;
}): Promise<LinkageOutcome> {
  const { flowsheetId, artistName, albumTitle } = args;
  const response = await lookupMetadata(artistName, albumTitle ?? undefined);
  const linkage = mapLookupToCanonicalEntity(response);
  if (!linkage) return { status: 'no_canonical_entity' };
  if (linkage.confidence < AUTO_ACCEPT_THRESHOLD) {
    return { status: 'low_confidence', canonicalEntityId: linkage.id, confidence: linkage.confidence };
  }

  const matches = await findLibraryRowsByCanonicalEntity(linkage.id);
  if (matches.length === 0) {
    return { status: 'no_library_match', canonicalEntityId: linkage.id, confidence: linkage.confidence };
  }

  if (matches.length > 1) {
    return {
      status: 'multi_match',
      canonicalEntityId: linkage.id,
      confidence: linkage.confidence,
      libraryIds: matches.map((m) => m.id),
    };
  }

  await setFlowsheetLinkage(flowsheetId, matches[0].id, 'lml_high_confidence', linkage.confidence);
  return {
    status: 'linked',
    libraryId: matches[0].id,
    canonicalEntityId: linkage.id,
    confidence: linkage.confidence,
  };
}
