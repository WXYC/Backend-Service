/**
 * Unit tests for the forward-path LML linkage service (B-2.1).
 *
 * After addEntry inserts a flowsheet row without album_id, this service is
 * fired-and-forgotten to resolve a canonical entity via LML and link the
 * row to the matching library album. The five outcomes match the issue's
 * acceptance criteria: linked / no_canonical_entity / low_confidence /
 * no_library_match / multi_match.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain, pickPrimaryLibraryRow } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: jest.fn().mockReturnValue(true),
  envInt: (_name: string, fallback: number) => fallback,
}));

import { runLmlLinkage } from '../../../apps/backend/services/flowsheet-linkage.service';

const directMatch = (release_id: number) => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id, release_url: '', confidence: 0 } }],
  search_type: 'direct',
  song_not_found: false,
  found_on_compilation: false,
});

const fallbackMatch = (release_id: number) => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id, release_url: '', confidence: 0 } }],
  search_type: 'fallback',
  song_not_found: false,
  found_on_compilation: false,
});

const noneMatch = () => ({
  results: [],
  search_type: 'none',
  song_not_found: false,
  found_on_compilation: false,
});

describe('runLmlLinkage (B-2.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('links the flowsheet row when a direct LML match resolves to exactly one library row', async () => {
    mockLookupMetadata.mockResolvedValue(directMatch(123456));

    // First chain: SELECT library rows by canonical_entity_id (one match)
    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([{ id: 88 }]);
    db.select.mockReturnValueOnce(selectChain);

    // Second chain: UPDATE flowsheet
    const updateChain = createMockQueryChain();
    db.update.mockReturnValueOnce(updateChain);

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Juana Molina',
      albumTitle: 'DOGA',
    });

    // Forward-path linkage fires the LML write-path warm so the discogs-cache
    // gets primed for any bio refs on the artist just played. The next iOS
    // lookup for the same artist renders richer profile_tokens for free.
    expect(mockLookupMetadata).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
      warm_cache: true,
    });
    expect(outcome).toEqual({
      status: 'linked',
      libraryId: 88,
      canonicalEntityId: 'discogs:release:123456',
      confidence: 0.9,
    });
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        album_id: 88,
        linkage_source: 'lml_high_confidence',
        linkage_confidence: 0.9,
        linked_at: expect.any(Date),
      })
    );
  });

  it('returns no_canonical_entity (no link, no DB write) when LML returns search_type=none', async () => {
    mockLookupMetadata.mockResolvedValue(noneMatch());

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Some Random Artist',
      albumTitle: 'Unknown Album',
    });

    expect(outcome).toEqual({ status: 'no_canonical_entity' });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns low_confidence (no link) for fallback matches — they belong in the review queue (B-3.1)', async () => {
    mockLookupMetadata.mockResolvedValue(fallbackMatch(987));

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Andy Stott',
      albumTitle: 'Faith In Strangers',
    });

    expect(outcome).toEqual({
      status: 'low_confidence',
      canonicalEntityId: 'discogs:release:987',
      confidence: 0.5,
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns no_library_match when the canonical entity exists but no library row carries it', async () => {
    mockLookupMetadata.mockResolvedValue(directMatch(555));

    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(selectChain);

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Jessica Pratt',
      albumTitle: 'Quiet Signs',
    });

    expect(outcome).toEqual({
      status: 'no_library_match',
      canonicalEntityId: 'discogs:release:555',
      confidence: 0.9,
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('links via the B-2.3 tie-break when several library rows share the canonical entity', async () => {
    // The forward path used to surface multi-match as an unlinked outcome.
    // With B-2.3 in place, the tie-break utility picks one library row
    // (rotation > format > plays > id) and the row is linked the same way
    // a single-match would be. This is the visible difference between the
    // old contract (multi_match) and the new one (linked).
    mockLookupMetadata.mockResolvedValue(directMatch(42));

    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([{ id: 10 }, { id: 11 }, { id: 12 }]);
    db.select.mockReturnValueOnce(selectChain);

    pickPrimaryLibraryRow.mockResolvedValueOnce(11);

    const updateChain = createMockQueryChain();
    db.update.mockReturnValueOnce(updateChain);

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Stereolab',
      albumTitle: 'Aluminum Tunes',
    });

    expect(pickPrimaryLibraryRow).toHaveBeenCalledWith([10, 11, 12]);
    expect(outcome).toEqual({
      status: 'linked',
      libraryId: 11,
      canonicalEntityId: 'discogs:release:42',
      confidence: 0.9,
    });
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        album_id: 11,
        linkage_source: 'lml_high_confidence',
        linkage_confidence: 0.9,
        linked_at: expect.any(Date),
      })
    );
  });

  it('returns no_library_match if the tie-break somehow picks nothing (concurrent delete safety net)', async () => {
    // pickPrimaryLibraryRow returns null when the candidate ids race with
    // a delete. The forward path should not fall back to a stale id from
    // its own SELECT — leave the row unlinked and let the next sweep
    // re-evaluate.
    mockLookupMetadata.mockResolvedValue(directMatch(42));

    const selectChain = createMockQueryChain();
    selectChain.where.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    db.select.mockReturnValueOnce(selectChain);

    pickPrimaryLibraryRow.mockResolvedValueOnce(null);

    const outcome = await runLmlLinkage({
      flowsheetId: 7,
      artistName: 'Stereolab',
      albumTitle: 'Aluminum Tunes',
    });

    expect(outcome).toEqual({
      status: 'no_library_match',
      canonicalEntityId: 'discogs:release:42',
      confidence: 0.9,
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});
