/**
 * Unit tests for shared/database/src/catalog-delete-envelope.ts (BS#2561 /
 * F2a). Tests the REAL module directly, same convention as
 * catalog-delete-snapshot.test.ts -- this is a pure module (no DB, no HTTP),
 * so there is nothing to mock.
 */
import {
  orderBatchEntities,
  parseCapturedEnvelope,
  UNRECOVERABLE_DEPENDENTS,
} from '../../../shared/database/src/catalog-delete-envelope';

describe('parseCapturedEnvelope', () => {
  it('reads the entity table/row and the children map', () => {
    const captured = {
      entity: { table: 'library', row: { id: 42, album_title: 'On Your Own Love Again' } },
      children: { bins: [{ id: 1 }], reviews: [] },
    };

    expect(parseCapturedEnvelope(captured)).toEqual({
      entity: { table: 'library', row: { id: 42, album_title: 'On Your Own Love Again' } },
      children: { bins: [{ id: 1 }], reviews: [] },
    });
  });

  it('reads a null entity row (the parent read found nothing)', () => {
    const captured = { entity: { table: 'library', row: null }, children: {} };
    expect(parseCapturedEnvelope(captured).entity.row).toBeNull();
  });

  it('does not throw on a malformed envelope, and returns an inert shape', () => {
    expect(parseCapturedEnvelope(null)).toEqual({ entity: { table: '', row: null }, children: {} });
    expect(parseCapturedEnvelope({})).toEqual({ entity: { table: '', row: null }, children: {} });
  });

  // BS#2561 F2a review finding 4: `table` was guarded by a `typeof ===
  // 'string'` check but `row`/`children` were not, so a wrong-typed value
  // passed straight through under a cast instead of reading as "absent" the
  // way the docstring promised. Each case below is the concrete
  // counterexample the review cited (or its natural sibling), asserted
  // directly against the type this module's declared return type claims.
  it('defends entity.row against a wrong-typed value the same way it defends entity.table', () => {
    const captured = { entity: { table: 'library', row: 'oops' }, children: {} };
    expect(parseCapturedEnvelope(captured)).toEqual({ entity: { table: 'library', row: null }, children: {} });
  });

  it('treats an array as a wrong-typed row too, not a plain object', () => {
    const captured = { entity: { table: 'library', row: [1, 2, 3] }, children: {} };
    expect(parseCapturedEnvelope(captured).entity.row).toBeNull();
  });

  it('defends children against a wrong-typed value, not just entity.table', () => {
    // The review's own counterexample.
    const captured = { entity: { table: 'library', row: 'oops' }, children: 7 };
    expect(parseCapturedEnvelope(captured)).toEqual({ entity: { table: 'library', row: null }, children: {} });
  });

  it('defends a wrong-typed child list inside an otherwise-valid children map', () => {
    const captured = {
      entity: { table: 'library', row: null },
      children: { bins: 'not-an-array', reviews: [{ id: 1 }] },
    };
    expect(parseCapturedEnvelope(captured).children).toEqual({ bins: [], reviews: [{ id: 1 }] });
  });
});

describe('orderBatchEntities', () => {
  it('is a no-op for a single-entity batch (the only shape that exists today)', () => {
    const rows = [{ id: 5, entity_kind: 'library' }];
    expect(orderBatchEntities(rows)).toEqual(rows);
  });

  it('orders an artist entity before a library entity that references it (BS#2562)', () => {
    const library = { id: 9, entity_kind: 'library' };
    const artist = { id: 7, entity_kind: 'artist' };
    expect(orderBatchEntities([library, artist])).toEqual([artist, library]);
  });

  it('tiebreaks same-kind entities by ascending id, and never mutates the input array', () => {
    const rows = [
      { id: 30, entity_kind: 'library' },
      { id: 10, entity_kind: 'library' },
      { id: 20, entity_kind: 'library' },
    ];
    const original = [...rows];
    expect(orderBatchEntities(rows).map((r) => r.id)).toEqual([10, 20, 30]);
    expect(rows).toEqual(original);
  });

  it('places an unrecognized entity_kind after every kind on the known precedence list', () => {
    const mystery = { id: 1, entity_kind: 'mystery' };
    const artist = { id: 2, entity_kind: 'artist' };
    const library = { id: 3, entity_kind: 'library' };
    expect(orderBatchEntities([mystery, library, artist])).toEqual([artist, library, mystery]);
  });
});

describe('UNRECOVERABLE_DEPENDENTS', () => {
  it('names the four derived tables and album_review_submissions, and nothing else', () => {
    expect(UNRECOVERABLE_DEPENDENTS).toEqual([
      'album_metadata',
      'library_identity',
      'library_identity_source',
      'uncovered_release_search_markers',
      'album_review_submissions',
    ]);
  });
});
