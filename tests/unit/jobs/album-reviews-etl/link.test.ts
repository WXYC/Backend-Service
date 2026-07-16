/**
 * Unit tests for the album-reviews-etl library link pass: the pure
 * singleton-match decision (exactly one library match links; zero or many
 * never write), the single-sweep orchestration over injected loaders, and
 * the no-overwrite UPDATE guard (`WHERE album_id IS NULL` — manual
 * corrections always win).
 */
import { db, normalizeAlbumTitle } from '@wxyc/database';
import {
  decideLink,
  linkSubmissions,
  writeLink,
  type LibraryCandidate,
  type UnlinkedSubmission,
} from '../../../../jobs/album-reviews-etl/link';

type MockDb = typeof db & {
  _chain: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
};

const mockDb = db as MockDb;

const submission = (overrides: Partial<UnlinkedSubmission> = {}): UnlinkedSubmission => ({
  id: 1,
  norm_artist: 'juana molina',
  norm_album: normalizeAlbumTitle('DOGA'),
  ...overrides,
});

const candidate = (overrides: Partial<LibraryCandidate> = {}): LibraryCandidate => {
  const album_title = overrides.album_title ?? 'DOGA';
  return {
    id: 501,
    album_title,
    norm_primary: 'juana molina',
    norm_album_artist: '',
    // Mirrors enrichCandidateRow: computed once per candidate at load time.
    norm_album_title: normalizeAlbumTitle(album_title),
    ...overrides,
  };
};

describe('decideLink (pure singleton rule)', () => {
  it('links when exactly one library row matches artist AND album', () => {
    expect(decideLink(submission(), [candidate()])).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('reports unmatched when no candidate matches the album title', () => {
    expect(decideLink(submission(), [candidate({ album_title: 'Segundo' })])).toEqual({ kind: 'unmatched' });
  });

  it('reports unmatched when the artist norms differ (candidate rows are a broad artist sweep)', () => {
    expect(decideLink(submission(), [candidate({ norm_primary: 'jessica pratt', norm_album_artist: '' })])).toEqual({
      kind: 'unmatched',
    });
  });

  it('reports ambiguous on two distinct matching library rows and links neither', () => {
    const decision = decideLink(submission(), [candidate({ id: 501 }), candidate({ id: 777 })]);
    expect(decision.kind).toBe('ambiguous');
  });

  it('matches through the album_artist leg too (compilations file the artist there)', () => {
    const viaAlbumArtist = candidate({ norm_primary: 'various artists', norm_album_artist: 'juana molina' });
    expect(decideLink(submission(), [viaAlbumArtist])).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('dedups a row matching via BOTH artist legs — still a singleton, not ambiguous', () => {
    const both = candidate({ norm_primary: 'juana molina', norm_album_artist: 'juana molina' });
    expect(decideLink(submission(), [both])).toEqual({ kind: 'linked', library_id: 501 });
  });

  it('compares album titles through normalizeAlbumTitle (edition suffixes collapse)', () => {
    const deluxe = candidate({ album_title: 'DOGA (Deluxe Edition)' });
    expect(decideLink(submission(), [deluxe])).toEqual({ kind: 'linked', library_id: 501 });
  });
});

describe('linkSubmissions (orchestration over injected deps)', () => {
  it('counts linked / link_ambiguous / link_unmatched and writes ONLY singletons', async () => {
    const writes: Array<[number, number]> = [];
    const totals = await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina' }),
          submission({ id: 2, norm_artist: 'stereolab', norm_album: normalizeAlbumTitle('Dots and Loops') }),
          submission({ id: 3, norm_artist: 'cat power', norm_album: normalizeAlbumTitle('Moon Pix') }),
        ]),
      loadCandidates: () =>
        Promise.resolve([
          candidate({ id: 501, norm_primary: 'juana molina', album_title: 'DOGA' }),
          candidate({ id: 601, norm_primary: 'stereolab', album_title: 'Dots and Loops' }),
          candidate({ id: 602, norm_primary: 'stereolab', album_title: 'Dots and Loops' }),
        ]),
      writeLink: (submissionId, libraryId) => {
        writes.push([submissionId, libraryId]);
        return Promise.resolve(true);
      },
    });

    expect(totals).toEqual({ linked: 1, link_ambiguous: 1, link_unmatched: 1 });
    expect(writes).toEqual([[1, 501]]);
  });

  it('passes each distinct norm_artist once per batch (no duplicate fan-out for multi-review artists)', async () => {
    const batches: string[][] = [];
    await linkSubmissions({
      loadUnlinked: () =>
        Promise.resolve([
          submission({ id: 1, norm_artist: 'juana molina' }),
          submission({ id: 2, norm_artist: 'juana molina', norm_album: normalizeAlbumTitle('Segundo') }),
          submission({ id: 3, norm_artist: 'jessica pratt', norm_album: normalizeAlbumTitle('Quiet Signs') }),
        ]),
      loadCandidates: (norms) => {
        batches.push([...norms]);
        return Promise.resolve([]);
      },
      writeLink: () => Promise.resolve(true),
    });

    const seen = batches.flat();
    expect(seen.filter((n) => n === 'juana molina')).toHaveLength(1);
    expect(seen.filter((n) => n === 'jessica pratt')).toHaveLength(1);
  });

  it('does not count a linked row when the guarded UPDATE reports no write (row linked out-of-band mid-run)', async () => {
    const totals = await linkSubmissions({
      loadUnlinked: () => Promise.resolve([submission({ id: 1 })]),
      loadCandidates: () => Promise.resolve([candidate({ id: 501 })]),
      writeLink: () => Promise.resolve(false), // WHERE album_id IS NULL matched nothing
    });
    expect(totals).toEqual({ linked: 0, link_ambiguous: 0, link_unmatched: 0 });
  });

  it('returns zeros for an empty unlinked set without loading candidates', async () => {
    const loadCandidates = jest.fn();
    const totals = await linkSubmissions({
      loadUnlinked: () => Promise.resolve([]),
      loadCandidates,
      writeLink: () => Promise.resolve(true),
    });
    expect(totals).toEqual({ linked: 0, link_ambiguous: 0, link_unmatched: 0 });
    expect(loadCandidates).not.toHaveBeenCalled();
  });
});

describe('writeLink (no-overwrite guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** True when the condition tree carries an IS NULL guard on album_id.
   *  Robust to both condition shapes (donor idiom): the unit env's
   *  drizzle-orm stub emits `{ and: [{ eq }, { isNull: 'album_id' }] }`;
   *  real drizzle nests SQL objects with StringChunk ` is null` text. */
  const hasAlbumIdIsNullGuard = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    const n = node as Record<string, unknown>;
    if (n.isNull === 'album_id') return true; // stub shape
    if (Array.isArray(n.value) && (n.value as unknown[]).some((v) => typeof v === 'string' && /is null/i.test(v))) {
      return true;
    }
    for (const child of [n.and, n.queryChunks]) {
      if (Array.isArray(child) && child.some((c) => hasAlbumIdIsNullGuard(c, seen))) return true;
    }
    return false;
  };

  it('UPDATEs album_id guarded by id AND album_id IS NULL so manual corrections and prior links always win', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 9 }]);
    await expect(writeLink(9, 501)).resolves.toBe(true);

    expect(mockDb._chain.set).toHaveBeenCalledWith({ album_id: 501 });
    const where = mockDb._chain.where.mock.calls[0][0];
    expect(hasAlbumIdIsNullGuard(where)).toBe(true);
  });

  it('returns false when the guard matched no row (already linked)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    await expect(writeLink(9, 501)).resolves.toBe(false);
  });
});
