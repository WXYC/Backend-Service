/**
 * Unit tests for the S1 resolver (library-identity-backfill).
 *
 * Sub-PR 2.0 reads from Backend's existing `library.canonical_entity_id`
 * column. Rows shaped `'discogs:<release_id>'` are the universe; everything
 * else is skipped (and counted in the orchestrator's `skipped` breakdown).
 *
 * The resolver maps `library` → per-source row(s) only. The writer composes
 * the main row via `recomputeMainRow`.
 */
import { resolveS1, type LibraryRow, type ResolveOutcome } from '../../../../jobs/library-identity-backfill/resolve';

const baseRow = (overrides: Partial<LibraryRow>): LibraryRow => ({
  id: 100,
  canonical_entity_id: 'discogs:987654',
  canonical_entity_resolved_at: new Date('2026-04-15T00:00:00Z'),
  ...overrides,
});

describe('resolveS1', () => {
  it('produces one per-source row for a discogs:<release_id> match', () => {
    const row = baseRow({ id: 100, canonical_entity_id: 'discogs:987654' });

    const outcome: ResolveOutcome = resolveS1(row);

    expect(outcome.status).toBe('match');
    if (outcome.status !== 'match') return;
    expect(outcome.sourceRows).toHaveLength(1);
    expect(outcome.sourceRows[0]).toEqual({
      library_id: 100,
      source: 'discogs_release',
      external_id: '987654',
      method: 'exact_match',
      confidence: 1.0,
      last_verified_at: row.canonical_entity_resolved_at,
      boost_sources: null,
      notes: 'backfill:S1',
    });
  });

  it('extracts the numeric release_id portion verbatim', () => {
    const row = baseRow({ canonical_entity_id: 'discogs:1' });
    const outcome = resolveS1(row);
    expect(outcome.status).toBe('match');
    if (outcome.status === 'match') {
      expect(outcome.sourceRows[0].external_id).toBe('1');
    }
  });

  it('reports non_discogs_namespace for non-discogs schemes', () => {
    // Future-proofing: when LML adds MB-only matches, those rows are written
    // by sub-PR 2.1+ via S2's reader, not S1. S1 only owns the discogs scheme.
    const row = baseRow({ canonical_entity_id: 'mb:abc-123' });
    const outcome = resolveS1(row);
    expect(outcome.status).toBe('non_discogs_namespace');
  });

  it('reports no_canonical_entity_id when the column is null', () => {
    // Rows without canonical_entity_id are skipped by S1; sub-PRs 2.1-2.3
    // pick them up via other source artifacts (LML entity.identity, etc.).
    const row = baseRow({ canonical_entity_id: null });
    const outcome = resolveS1(row);
    expect(outcome.status).toBe('no_canonical_entity_id');
  });

  it('rejects malformed discogs:<id> values where <id> is not an integer', () => {
    // The substrate stores canonical_entity_id as opaque text; if a malformed
    // value snuck in, surface it as a skip rather than corrupting the
    // per-source table with a non-integer external_id.
    const row = baseRow({ canonical_entity_id: 'discogs:not-a-number' });
    const outcome = resolveS1(row);
    expect(outcome.status).toBe('non_discogs_namespace');
  });

  it('falls back to a synthesized timestamp when canonical_entity_resolved_at is null', () => {
    // The substrate's library_canonical_entity_backfill always sets
    // resolved_at on a successful auto_accept, but defensive: if a row was
    // populated by a hand-edit that skipped resolved_at, the backfill must
    // still produce a per-source row with a valid last_verified_at.
    const row = baseRow({ canonical_entity_resolved_at: null });
    const outcome = resolveS1(row);
    expect(outcome.status).toBe('match');
    if (outcome.status === 'match') {
      expect(outcome.sourceRows[0].last_verified_at).toBeInstanceOf(Date);
    }
  });
});
