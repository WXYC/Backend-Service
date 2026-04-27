/**
 * Manual review CLI for B-3.1's flowsheet linkage queue (issue #501).
 *
 * Drains `flowsheet_linkage_review` one entry at a time, showing the
 * operator the flowsheet artist/album/track text and the LML-ranked
 * library candidates. The operator answers y/n/skip per case:
 *   - y     → stamp `flowsheet.album_id` with the chosen library row,
 *             linkage_source='human_review', linked_at=now(); mark the
 *             review row reviewed_decision='accepted'.
 *   - n     → mark the review row reviewed_decision='rejected'. The
 *             flowsheet row stays unmatched so a future LML improvement
 *             can pick it up.
 *   - skip  → no DB write. Within this session the case won't recur;
 *             the next session shows it again.
 *
 * Usage:
 *   npx tsx scripts/review-linkage.ts
 *
 * Web UI is out of scope for v1; the CLI is sufficient until volume
 * justifies otherwise.
 */

import { config } from 'dotenv';
config();

import readline from 'node:readline';
import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

export type ReviewCandidate = {
  libraryId: number;
  artistName: string | null;
  albumTitle: string | null;
  confidence: number;
};

export type ReviewCase = {
  reviewId: number;
  flowsheetId: number;
  flowsheetArtist: string | null;
  flowsheetAlbum: string | null;
  flowsheetTrack: string | null;
  suggestedAction: string;
  candidates: ReviewCandidate[];
};

type QueueRow = {
  id: number;
  flowsheet_id: number;
  candidate_library_ids: number[] | null;
  candidate_confidences: number[] | null;
  suggested_action: string;
  flowsheet_artist: string | null;
  flowsheet_album: string | null;
  flowsheet_track: string | null;
};

type LibraryRow = {
  id: number;
  artist_name: string | null;
  album_title: string | null;
};

/**
 * Read the oldest unreviewed queue row plus the metadata for its candidate
 * library rows. The two-step shape (queue join → library lookup) keeps the
 * SQL simple; a single CTE-with-array-unnest would also work but is harder
 * to read and unit-test.
 *
 * `excludeIds` is the in-memory skip list: rows the operator skipped within
 * the current CLI session. They aren't marked reviewed in the DB, so the
 * next session will see them again — but for the duration of this run we
 * skip past them.
 */
export const loadNextReviewCase = async (excludeIds: number[] = []): Promise<ReviewCase | null> => {
  // Validated integer IDs are safe to inline via sql.raw; we still coerce
  // through Number to make the contract explicit.
  const safeExclusion =
    excludeIds.length > 0
      ? sql.raw(`AND r."id" NOT IN (${excludeIds.map((id) => Number(id)).join(', ')})`)
      : sql.raw('');

  const rows = (await db.execute(sql`
    SELECT
      r."id",
      r."flowsheet_id",
      r."candidate_library_ids",
      r."candidate_confidences",
      r."suggested_action",
      f."artist_name" AS "flowsheet_artist",
      f."album_title" AS "flowsheet_album",
      f."track_title" AS "flowsheet_track"
    FROM "wxyc_schema"."flowsheet_linkage_review" r
    JOIN "wxyc_schema"."flowsheet" f ON f."id" = r."flowsheet_id"
    WHERE r."reviewed_at" IS NULL
      ${safeExclusion}
    ORDER BY r."created_at" ASC
    LIMIT 1
  `)) as unknown as QueueRow[];

  const head = rows?.[0];
  if (!head) return null;

  const ids = head.candidate_library_ids ?? [];
  const confidences = head.candidate_confidences ?? [];

  let libraryRows: LibraryRow[] = [];
  if (ids.length > 0) {
    const idList = sql.raw(ids.map((id) => Number(id)).join(', '));
    libraryRows = (await db.execute(sql`
      SELECT "id", "artist_name", "album_title"
      FROM "wxyc_schema"."library"
      WHERE "id" IN (${idList})
    `)) as unknown as LibraryRow[];
  }

  const byId = new Map<number, LibraryRow>();
  for (const lib of libraryRows ?? []) byId.set(lib.id, lib);

  const candidates: ReviewCandidate[] = ids.map((id, index) => {
    const lib = byId.get(id);
    return {
      libraryId: id,
      artistName: lib?.artist_name ?? null,
      albumTitle: lib?.album_title ?? null,
      confidence: confidences[index] ?? 0,
    };
  });

  return {
    reviewId: head.id,
    flowsheetId: head.flowsheet_id,
    flowsheetArtist: head.flowsheet_artist,
    flowsheetAlbum: head.flowsheet_album,
    flowsheetTrack: head.flowsheet_track,
    suggestedAction: head.suggested_action,
    candidates,
  };
};

/**
 * Accept the operator's pick: stamp the flowsheet row and mark the queue
 * row reviewed. The `album_id IS NULL` guard on the flowsheet UPDATE is the
 * same idempotency rail the B-2.2 backfill uses — if a parallel linker got
 * there first between the queue read and this write, our UPDATE is a no-op
 * and the queue row still gets marked reviewed (the operator's intent
 * matches the existing link, so there's nothing left to reconcile).
 *
 * The two writes are not wrapped in a transaction. Splitting them keeps
 * the CLI dead simple, and the failure modes are benign: if the second
 * UPDATE fails, the next session re-shows the case and an idempotent
 * accept is a no-op on the flowsheet (already linked) and finally marks
 * the queue row reviewed.
 */
export const acceptReviewCase = async (args: {
  reviewId: number;
  flowsheetId: number;
  libraryId: number;
}): Promise<void> => {
  await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet"
    SET "album_id" = ${args.libraryId},
        "linkage_source" = 'human_review',
        "linked_at" = now()
    WHERE "id" = ${args.flowsheetId}
      AND "album_id" IS NULL
  `);

  await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet_linkage_review"
    SET "reviewed_at" = now(),
        "reviewed_decision" = 'accepted'
    WHERE "id" = ${args.reviewId}
  `);
};

export const rejectReviewCase = async (reviewId: number): Promise<void> => {
  await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet_linkage_review"
    SET "reviewed_at" = now(),
        "reviewed_decision" = 'rejected'
    WHERE "id" = ${reviewId}
  `);
};

const formatCandidate = (candidate: ReviewCandidate, index: number): string => {
  const meta = `${candidate.artistName ?? '?'} — ${candidate.albumTitle ?? '?'}`;
  return `  [${index + 1}] library_id=${candidate.libraryId} | ${meta} | confidence=${candidate.confidence.toFixed(2)}`;
};

const renderCase = (reviewCase: ReviewCase): string => {
  const header = `\nReview case #${reviewCase.reviewId} (flowsheet_id=${reviewCase.flowsheetId}, ${reviewCase.suggestedAction})`;
  const flowsheet =
    `  Flowsheet text: artist="${reviewCase.flowsheetArtist ?? ''}"` +
    ` album="${reviewCase.flowsheetAlbum ?? ''}"` +
    ` track="${reviewCase.flowsheetTrack ?? ''}"`;
  if (reviewCase.candidates.length === 0) {
    return `${header}\n${flowsheet}\n  (No local library candidates — only n / s available.)`;
  }
  const candidates = reviewCase.candidates.map(formatCandidate).join('\n');
  return `${header}\n${flowsheet}\nCandidates:\n${candidates}`;
};

const ask = (rl: readline.Interface, question: string): Promise<string> =>
  new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim().toLowerCase())));

const PROMPT = 'Action — accept candidate # / [n]o-match / [s]kip / [q]uit: ';

const main = async (): Promise<void> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const skipped: number[] = [];
  let stats = { accepted: 0, rejected: 0, skipped: 0 };

  try {
    while (true) {
      const next = await loadNextReviewCase(skipped);
      if (!next) {
        console.log('\nReview queue is empty. Done.');
        break;
      }

      console.log(renderCase(next));
      const answer = await ask(rl, PROMPT);

      if (answer === 'q' || answer === 'quit') {
        console.log('\nQuitting.');
        break;
      }
      if (answer === 's' || answer === 'skip' || answer === '') {
        skipped.push(next.reviewId);
        stats.skipped += 1;
        continue;
      }
      if (answer === 'n' || answer === 'no') {
        await rejectReviewCase(next.reviewId);
        stats.rejected += 1;
        continue;
      }

      const pick = Number.parseInt(answer, 10);
      if (!Number.isInteger(pick) || pick < 1 || pick > next.candidates.length) {
        console.log(`Unrecognized response "${answer}" — skipping.`);
        skipped.push(next.reviewId);
        stats.skipped += 1;
        continue;
      }

      const candidate = next.candidates[pick - 1];
      await acceptReviewCase({
        reviewId: next.reviewId,
        flowsheetId: next.flowsheetId,
        libraryId: candidate.libraryId,
      });
      stats.accepted += 1;
    }

    console.log(`\nSession totals: accepted=${stats.accepted} rejected=${stats.rejected} skipped=${stats.skipped}`);
  } finally {
    rl.close();
    await closeDatabaseConnection();
  }
};

// Only run main() when invoked as a script. Tests import the helpers
// directly without triggering the interactive loop.
const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const arg = process.argv[1];
  return arg.endsWith('review-linkage.ts') || arg.endsWith('review-linkage.js');
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
  });
}
