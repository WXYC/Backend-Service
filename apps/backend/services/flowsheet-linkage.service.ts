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
 *      - 2+ rows → run the B-2.3 tie-break (rotation > format > plays > id)
 *        and link to the picked row. If the tie-break returns null (a rare
 *        race with a concurrent delete), leave the row unlinked.
 */
import { eq } from 'drizzle-orm';
import { db, flowsheet, library, pickPrimaryLibraryRow } from '@wxyc/database';
import { lookupMetadata } from '@wxyc/lml-client';
import { mapLookupToCanonicalEntity } from './library.service.js';
import { classifyLinkageError, incrementLinkageMetric, reportLinkageError } from './linkage-metrics.service.js';

const AUTO_ACCEPT_THRESHOLD = 0.9;

export type LinkageOutcome =
  | { status: 'linked'; libraryId: number; canonicalEntityId: string; confidence: number }
  | { status: 'no_canonical_entity' }
  | { status: 'low_confidence'; canonicalEntityId: string; confidence: number }
  | { status: 'no_library_match'; canonicalEntityId: string; confidence: number }
  | { status: 'error'; error: unknown };

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

  let response;
  try {
    // warm_cache=true: this is the write-path entry point for newly inserted
    // flowsheet rows. LML schedules a fire-and-forget background task that
    // deep-parses the top-1 artist's bio against the API-capable resolver,
    // populating the discogs-cache for referenced entities (`[a…]`/`[r…]`/
    // `[m…]`). Subsequent read-path lookups for the same artist (typically
    // an iOS listener fetching playcut metadata seconds later) get richer
    // profile_tokens for free, without adding latency to this write path.
    // LML bounds concurrent warm tasks process-wide to cap Discogs amplification.
    response = await lookupMetadata(artistName, albumTitle ?? undefined, undefined, {
      warm_cache: true,
      caller: 'flowsheet-linkage',
    });
  } catch (error) {
    // The forward path is fire-and-forget — we own error reporting here so
    // the caller's `.catch` is only a safety net for unexpected bugs.
    incrementLinkageMetric(classifyLinkageError(error));
    reportLinkageError(error, { flowsheetId, artistName, albumTitle }, { path: 'forward' });
    return { status: 'error', error };
  }

  const linkage = mapLookupToCanonicalEntity(response);
  if (!linkage) {
    incrementLinkageMetric('no_candidate');
    return { status: 'no_canonical_entity' };
  }
  if (linkage.confidence < AUTO_ACCEPT_THRESHOLD) {
    incrementLinkageMetric('gray_zone_review');
    return { status: 'low_confidence', canonicalEntityId: linkage.id, confidence: linkage.confidence };
  }

  const matches = await findLibraryRowsByCanonicalEntity(linkage.id);
  if (matches.length === 0) {
    incrementLinkageMetric('no_candidate');
    return { status: 'no_library_match', canonicalEntityId: linkage.id, confidence: linkage.confidence };
  }

  const pickedId = matches.length === 1 ? matches[0].id : await pickPrimaryLibraryRow(matches.map((m) => m.id));
  if (pickedId === null) {
    // Tie-break returned no row — the candidates raced with a concurrent
    // delete. Leave the row unlinked; the next B-2.2 sweep will retry.
    incrementLinkageMetric('no_candidate');
    return { status: 'no_library_match', canonicalEntityId: linkage.id, confidence: linkage.confidence };
  }

  await setFlowsheetLinkage(flowsheetId, pickedId, 'lml_high_confidence', linkage.confidence);
  incrementLinkageMetric('linked_high_conf');
  return {
    status: 'linked',
    libraryId: pickedId,
    canonicalEntityId: linkage.id,
    confidence: linkage.confidence,
  };
}
