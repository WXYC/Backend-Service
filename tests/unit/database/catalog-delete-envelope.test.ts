/**
 * Unit tests for shared/database/src/catalog-delete-envelope.ts (BS#2561 /
 * F2a). Tests the REAL module directly, same convention as
 * catalog-delete-snapshot.test.ts -- this is a pure module (no DB, no HTTP),
 * so there is nothing to mock.
 */
import {
  orderBatchEntities,
  parseCapturedEnvelope,
  UNRECOVERABLE_ARTIST_DEPENDENTS,
  UNRECOVERABLE_DEPENDENTS,
  unrecoverableDependentsForKinds,
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

describe('UNRECOVERABLE_ARTIST_DEPENDENTS', () => {
  // Derived from the six FK columns an artist delete neither refuses on nor
  // captures, deduped to five tables (`artist_search_alias` carries two of
  // those columns).
  it('names the five tables an artist delete loses, and nothing else', () => {
    expect(UNRECOVERABLE_ARTIST_DEPENDENTS).toEqual([
      'artist_search_alias',
      'artist_similar_artists',
      'artist_station_plays',
      'concerts',
      'concert_performers',
    ]);
  });

  // The two lists must stay disjoint, because the batch value is their union
  // and an overlap would make an artist batch's list read as though a release
  // table were involved.
  it('shares no table with the release list', () => {
    const release = new Set<string>(UNRECOVERABLE_DEPENDENTS);
    for (const table of UNRECOVERABLE_ARTIST_DEPENDENTS) {
      expect(release.has(table)).toBe(false);
    }
  });
});

describe('unrecoverableDependentsForKinds', () => {
  // The defect this replaced: one constant list, attached to every batch. An
  // artist batch was handed the five RELEASE tables -- none of which an artist
  // delete touches -- while saying nothing about the five it does, which is
  // exactly the lossless-restore promise the field exists to avoid making.
  it('gives an artist batch the artist tables and none of the release ones', () => {
    const answer = unrecoverableDependentsForKinds(['artist']);

    expect(answer.sort()).toEqual([...UNRECOVERABLE_ARTIST_DEPENDENTS].sort());
    for (const releaseTable of UNRECOVERABLE_DEPENDENTS) {
      expect(answer).not.toContain(releaseTable);
    }
  });

  it('gives a release batch the release tables and none of the artist ones', () => {
    const answer = unrecoverableDependentsForKinds(['library']);

    expect(answer.sort()).toEqual([...UNRECOVERABLE_DEPENDENTS].sort());
    for (const artistTable of UNRECOVERABLE_ARTIST_DEPENDENTS) {
      expect(answer).not.toContain(artistTable);
    }
  });

  // No writer produces a mixed batch today, so this is the contract for one
  // that might rather than a case under test in production.
  it('unions both lists for a batch holding both kinds', () => {
    const answer = unrecoverableDependentsForKinds(['artist', 'library']);

    expect(answer.sort()).toEqual(
      [...UNRECOVERABLE_DEPENDENTS, ...UNRECOVERABLE_ARTIST_DEPENDENTS].sort()
    );
  });

  it('dedupes a kind repeated across a batch\'s entities', () => {
    expect(unrecoverableDependentsForKinds(['library', 'library', 'library'])).toEqual([
      ...UNRECOVERABLE_DEPENDENTS,
    ]);
  });

  // Understate rather than throw, matching `orderBatchEntities`: a listing
  // that 500s on one unfamiliar row is worse than one that renders it with a
  // short list.
  it('contributes nothing for an unrecognized entity_kind rather than throwing', () => {
    expect(unrecoverableDependentsForKinds(['something_new'])).toEqual([]);
    expect(unrecoverableDependentsForKinds(['artist', 'something_new']).sort()).toEqual(
      [...UNRECOVERABLE_ARTIST_DEPENDENTS].sort()
    );
  });

  it('answers an empty batch with an empty list', () => {
    expect(unrecoverableDependentsForKinds([])).toEqual([]);
  });
});
