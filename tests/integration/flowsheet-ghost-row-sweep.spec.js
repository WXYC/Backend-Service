/**
 * Integration test for the flowsheet + rotation ghost-row sweep (BS#1887),
 * against real PostgreSQL.
 *
 * The unit suite (tests/unit/jobs/flowsheet-ghost-row-sweep/orchestrate.test.ts)
 * pins the orchestrator's loop/batching/resume-cursor/failure behavior
 * against a mocked db; this spec validates the actual SQL + FK semantics
 * against a real schema — the anti-join candidate SELECT, the batched
 * DELETE, and the two blast-radius behaviors called out in the issue body:
 * `flowsheet` → `flowsheet_linkage_review` CASCADE (migration 0067) and
 * `rotation` → `flowsheet.rotation_id` SET NULL (migration 0097).
 *
 * Pure SQL — does NOT import `jobs/flowsheet-ghost-row-sweep/orchestrate.ts`.
 * Integration runner is babel-jest with no TS support (see
 * flowsheet-metadata-backfill-worklist.spec.js for the same convention).
 * The statements below mirror `loadBatchOnce` / `deleteBatch` in
 * orchestrate.ts (candidate SELECT: `legacy_id IS NOT NULL ... ORDER BY
 * id`; DELETE: `id = ANY(...)`), plus an `id = ANY(seededIds)` scope clause
 * that orchestrate.ts does NOT carry — the dev DB's `LOAD_CLONE_FIXTURE`
 * prod clone (docs/dev-db-fixture.md) seeds thousands of real
 * `legacy_entry_id` / `legacy_rotation_id` rows, and this spec's keyspace
 * fixture only knows about the ids it seeded itself; without the scope
 * clause every real clone row would anti-join as a false-positive ghost.
 * When orchestrate.ts's real predicate changes shape, the SQL here must
 * follow. The in-process anti-join against a loaded keyspace `Set` is
 * reproduced in plain JS, matching the real module's
 * `keyspace.has(row.legacy_id)` test.
 */

const { getTestDb, withRollback } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Marker range kept well clear of the shape fixture (7000-7099) and the
// post-fixture serial floor other specs rely on (7200+) — these tests seed
// their legacy ids explicitly rather than relying on sequence position, so
// only the *legacy* id values need to be collision-free, not the serial ids.
const GHOST_FLOWSHEET_LEGACY_ID = 999001;
const PRESENT_FLOWSHEET_LEGACY_ID = 999002;
const GHOST_ROTATION_LEGACY_ID = 999101;
const PRESENT_ROTATION_LEGACY_ID = 999102;

/**
 * Mirror of orchestrate.ts's `loadBatchOnce` for one target, unpaged (small
 * fixture, single page is enough) and scoped to this test's own seeded rows
 * (see file header — the dev DB's clone fixture has thousands of real rows
 * this spec's tiny keyspace fixture doesn't know about).
 */
async function selectCandidates(tx, table, legacyColumn, seededIds) {
  return tx`
    SELECT "id", ${tx(legacyColumn)} AS "legacy_id"
    FROM ${tx(SCHEMA)}.${tx(table)}
    WHERE ${tx(legacyColumn)} IS NOT NULL
      AND "id" = ANY(${seededIds})
    ORDER BY "id" ASC
  `;
}

/** Mirror of orchestrate.ts's in-process anti-join: a row is a ghost iff its legacy id isn't in the keyspace Set. */
function ghostIds(rows, keyspace) {
  return rows.filter((r) => !keyspace.has(r.legacy_id)).map((r) => r.id);
}

/** Mirror of orchestrate.ts's `deleteBatch`. */
async function deleteByIds(tx, table, ids) {
  if (ids.length === 0) return;
  await tx`DELETE FROM ${tx(SCHEMA)}.${tx(table)} WHERE "id" = ANY(${ids})`;
}

describe('flowsheet + rotation ghost-row sweep (real PG, BS#1887)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  describe('dry-run: candidate identification only, zero writes', () => {
    it('flags exactly the rows whose legacy id is absent from the keyspace, and writes nothing', async () => {
      await withRollback(async (tx) => {
        const [ghostFlowsheet] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet (legacy_entry_id, entry_type, play_order, message)
          VALUES (${GHOST_FLOWSHEET_LEGACY_ID}, 'track', 1, 'bs1887-dry-run-ghost')
          RETURNING id
        `;
        const [presentFlowsheet] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet (legacy_entry_id, entry_type, play_order, message)
          VALUES (${PRESENT_FLOWSHEET_LEGACY_ID}, 'track', 2, 'bs1887-dry-run-present')
          RETURNING id
        `;
        const [ghostRotation] = await tx`
          INSERT INTO ${tx(SCHEMA)}.rotation (legacy_rotation_id, rotation_bin)
          VALUES (${GHOST_ROTATION_LEGACY_ID}, 'L')
          RETURNING id
        `;
        const [presentRotation] = await tx`
          INSERT INTO ${tx(SCHEMA)}.rotation (legacy_rotation_id, rotation_bin)
          VALUES (${PRESENT_ROTATION_LEGACY_ID}, 'L')
          RETURNING id
        `;

        const flowsheetKeyspace = new Set([PRESENT_FLOWSHEET_LEGACY_ID]);
        const rotationKeyspace = new Set([PRESENT_ROTATION_LEGACY_ID]);

        const flowsheetCandidates = await selectCandidates(tx, 'flowsheet', 'legacy_entry_id', [
          ghostFlowsheet.id,
          presentFlowsheet.id,
        ]);
        const rotationCandidates = await selectCandidates(tx, 'rotation', 'legacy_rotation_id', [
          ghostRotation.id,
          presentRotation.id,
        ]);

        const flowsheetGhosts = ghostIds(flowsheetCandidates, flowsheetKeyspace);
        const rotationGhosts = ghostIds(rotationCandidates, rotationKeyspace);

        expect(flowsheetGhosts).toEqual([ghostFlowsheet.id]);
        expect(flowsheetGhosts).not.toContain(presentFlowsheet.id);
        expect(rotationGhosts).toEqual([ghostRotation.id]);
        expect(rotationGhosts).not.toContain(presentRotation.id);

        // Dry-run: no DELETE issued. Both rows on both tables still exist.
        const stillThere = await tx`
          SELECT id FROM ${tx(SCHEMA)}.flowsheet WHERE id = ANY(${[ghostFlowsheet.id, presentFlowsheet.id]})
        `;
        expect(stillThere).toHaveLength(2);
      });
    });
  });

  describe('--execute: batched DELETE removes exactly the ghosts, blast radius verified', () => {
    it('removes ghost rows, leaves present-upstream rows untouched, cascades to flowsheet_linkage_review', async () => {
      await withRollback(async (tx) => {
        const [ghostFlowsheet] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet (legacy_entry_id, entry_type, play_order, message)
          VALUES (${GHOST_FLOWSHEET_LEGACY_ID}, 'track', 1, 'bs1887-execute-ghost')
          RETURNING id
        `;
        const [presentFlowsheet] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet (legacy_entry_id, entry_type, play_order, message)
          VALUES (${PRESENT_FLOWSHEET_LEGACY_ID}, 'track', 2, 'bs1887-execute-present')
          RETURNING id
        `;
        // Cascade fixture: a linkage-review row queued against the ghost
        // flowsheet entry — must die with it (migration 0067, ON DELETE CASCADE).
        const [linkageReview] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet_linkage_review
            (flowsheet_id, candidate_library_ids, candidate_confidences, suggested_action)
          VALUES (${ghostFlowsheet.id}, '{}', '{}', 'review_fallback')
          RETURNING id
        `;

        const flowsheetKeyspace = new Set([PRESENT_FLOWSHEET_LEGACY_ID]);
        const flowsheetCandidates = await selectCandidates(tx, 'flowsheet', 'legacy_entry_id', [
          ghostFlowsheet.id,
          presentFlowsheet.id,
        ]);
        const flowsheetGhosts = ghostIds(flowsheetCandidates, flowsheetKeyspace);
        expect(flowsheetGhosts).toEqual([ghostFlowsheet.id]);

        await deleteByIds(tx, 'flowsheet', flowsheetGhosts);

        const afterFlowsheet = await tx`
          SELECT id FROM ${tx(SCHEMA)}.flowsheet WHERE id = ANY(${[ghostFlowsheet.id, presentFlowsheet.id]})
        `;
        expect(afterFlowsheet.map((r) => r.id)).toEqual([presentFlowsheet.id]);

        const afterLinkageReview = await tx`
          SELECT id FROM ${tx(SCHEMA)}.flowsheet_linkage_review WHERE id = ${linkageReview.id}
        `;
        expect(afterLinkageReview).toHaveLength(0);
      });
    });

    it('SET-NULLs a legit flowsheet row pointing at a ghost rotation row rather than blocking or deleting it', async () => {
      await withRollback(async (tx) => {
        const [ghostRotation] = await tx`
          INSERT INTO ${tx(SCHEMA)}.rotation (legacy_rotation_id, rotation_bin)
          VALUES (${GHOST_ROTATION_LEGACY_ID}, 'L')
          RETURNING id
        `;
        const [presentRotation] = await tx`
          INSERT INTO ${tx(SCHEMA)}.rotation (legacy_rotation_id, rotation_bin)
          VALUES (${PRESENT_ROTATION_LEGACY_ID}, 'L')
          RETURNING id
        `;
        // A legit (non-ghost, no legacy_entry_id) flowsheet row that happens
        // to be linked to the soon-to-be-swept ghost rotation.
        const [legitFlowsheet] = await tx`
          INSERT INTO ${tx(SCHEMA)}.flowsheet (rotation_id, entry_type, play_order, message)
          VALUES (${ghostRotation.id}, 'track', 3, 'bs1887-rotation-set-null')
          RETURNING id
        `;

        const rotationKeyspace = new Set([PRESENT_ROTATION_LEGACY_ID]);
        const rotationCandidates = await selectCandidates(tx, 'rotation', 'legacy_rotation_id', [
          ghostRotation.id,
          presentRotation.id,
        ]);
        const rotationGhosts = ghostIds(rotationCandidates, rotationKeyspace);
        expect(rotationGhosts).toEqual([ghostRotation.id]);

        // Sweeping the ghost rotation must not error even though a live
        // flowsheet row still references it — ON DELETE SET NULL handles it.
        await expect(deleteByIds(tx, 'rotation', rotationGhosts)).resolves.not.toThrow();

        const afterRotation = await tx`
          SELECT id FROM ${tx(SCHEMA)}.rotation WHERE id = ANY(${[ghostRotation.id, presentRotation.id]})
        `;
        expect(afterRotation.map((r) => r.id)).toEqual([presentRotation.id]);

        const afterFlowsheet = await tx`
          SELECT rotation_id FROM ${tx(SCHEMA)}.flowsheet WHERE id = ${legitFlowsheet.id}
        `;
        expect(afterFlowsheet).toHaveLength(1);
        expect(afterFlowsheet[0].rotation_id).toBeNull();
      });
    });
  });
});
