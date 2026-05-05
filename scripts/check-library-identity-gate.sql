-- Gate-check for cross-cache-identity project per
-- plans/library-hook-canonicalization-plan.md §3.2.3. Returns 'PASS' when the
-- backfill-complete gate is met (truly_unresolved_rows < 1000).
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/check-library-identity-gate.sql
--
-- The query is also referenced by `scripts/check-precondition-guards.sh`'s
-- regex pattern; downstream migrations that FK-reference or constraint-add
-- against `library_identity*` must inline this gate's logic in a
-- `DO $$ ... RAISE EXCEPTION ... END $$` block at the top of the migration
-- (or use the `-- precondition-guard: not-required (rationale)` opt-out).
--
-- Definition of "truly unresolved": `library_identity.confidence < 0.70`
-- AND no fallback `library_identity` row exists for a sibling library row
-- (same artist_id) at confidence ≥0.70 with method != 'inherited'. The
-- non-inherited requirement prevents transitive chains (sibling -> sibling
-- -> unresolved) from masking gate failures; see §3.2.3 for the full
-- rationale and §3.4.1.1 Rule 3 for the inheritance composition rule.
--
-- During Phase 1 (substrate landed, no use), the gate is informational only —
-- both `library_identity` and `wxyc_schema.library` are joined LEFT, so every
-- library row appears as unresolved with confidence=0 and the gate naturally
-- FAILs until backfill (§4 step 2) populates the tables.

WITH unresolved AS (
  SELECT l.id AS library_id, l.artist_id
  FROM wxyc_schema.library l
  LEFT JOIN wxyc_schema.library_identity li ON li.library_id = l.id
  WHERE COALESCE(li.confidence, 0) < 0.70
),
-- A library row is "fallback resolved" if it has a sibling (same artist_id)
-- whose library_identity is at confidence >=0.70 AND method is NOT 'inherited'.
-- The non-inherited requirement is critical: it forbids transitive chains
-- (sibling -> sibling -> sibling). The fallback root must be a deterministic
-- decision, not another inherited row.
fallback_resolved AS (
  SELECT u.library_id
  FROM unresolved u
  WHERE EXISTS (
    SELECT 1
    FROM wxyc_schema.library sib
    JOIN wxyc_schema.library_identity sib_li ON sib_li.library_id = sib.id
    WHERE sib.artist_id = u.artist_id
      AND sib.id != u.library_id          -- exclude self
      AND sib_li.confidence >= 0.70
      AND sib_li.method != 'inherited'    -- root must be deterministic, not transitive
  )
)
SELECT
  (SELECT COUNT(*) FROM wxyc_schema.library) AS total_library_rows,
  (SELECT COUNT(*) FROM unresolved) AS unresolved_rows,
  (SELECT COUNT(*) FROM fallback_resolved) AS fallback_resolved_rows,
  (SELECT COUNT(*) FROM unresolved
     WHERE library_id NOT IN (SELECT library_id FROM fallback_resolved)
  ) AS truly_unresolved_rows,
  CASE
    WHEN (SELECT COUNT(*) FROM unresolved
            WHERE library_id NOT IN (SELECT library_id FROM fallback_resolved)) < 1000 THEN 'PASS'
    ELSE 'FAIL'
  END AS gate_status;
