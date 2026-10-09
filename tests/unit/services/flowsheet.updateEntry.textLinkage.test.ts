/**
 * `updateEntry` text-linkage rules (BS#3065, part 2 of BS#3057).
 *
 * The DJ site sends one field per PATCH, so the edit path merges the patch with the row it locks and decides
 * what the flowsheet -> library link should be:
 *
 *  1. a non-null `album_id` in the patch is a pick: `dj_bin_pick`, no confidence;
 *  2. `album_id: null` unlinks and clears all three linkage columns;
 *  3. an artist/album text edit on a TRACK row that is unlinked or `direct_text_match`-linked re-runs the
 *     matcher: one candidate links, several keep the current link only if it is among them, none clears.
 *     Rows linked any other way, and non-track rows, are never touched by an edit.
 *
 * The transaction, the locked pre-read and the final UPDATE are scripted; the matcher is the real
 * `findLibraryReleasesByText` over a scripted `db`, so a lookup that rejects exercises the real catch.
 */

jest.unmock('drizzle-orm');

jest.mock('@sentry/node', () => {
  const actual = jest.requireActual('@sentry/node');
  return { ...actual, captureException: jest.fn() };
});

const mockLookup = jest.fn();
const mockPreRead = jest.fn();
const mockUpdateSet = jest.fn();
const mockForLock = jest.fn();
const mockLookupWhere = jest.fn();

/** A thenable drizzle-shaped chain: every builder method returns it, and awaiting it yields `result()`. */
const chain = (result: () => unknown, hooks: Record<string, (...args: any[]) => void> = {}) => {
  const c: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve().then(result).then(resolve, reject);
        return (...args: any[]) => {
          hooks[prop]?.(...args);
          return c;
        };
      },
    }
  );
  return c;
};

jest.mock('@wxyc/database', () => {
  const trx = {
    select: () =>
      chain(() => mockPreRead(), {
        for: (...args) => mockForLock(...args),
      }),
    update: () =>
      chain(() => [{ id: 7 }], {
        set: (...args) => mockUpdateSet(...args),
      }),
  };
  const scriptedDb = {
    transaction: (cb: (t: typeof trx) => unknown) => Promise.resolve(cb(trx)),
    select: () => chain(() => mockLookup(), { where: (...args) => mockLookupWhere(...args) }),
  };
  return jest.requireActual('../../utils/real-database-module').realDatabaseModule({ db: scriptedDb });
});

import * as Sentry from '@sentry/node';
import { PgDialect } from 'drizzle-orm/pg-core';
import { updateEntry } from '../../../apps/backend/services/flowsheet.service';

const track = (over: Record<string, unknown> = {}) => ({
  entry_type: 'track',
  artist_name: 'Jessica Pratt',
  album_title: 'Quiet Signs',
  album_id: null,
  linkage_source: null,
  ...over,
});

const CLEARED = { linkage_source: null, linkage_confidence: null, linked_at: null };

/** The merged object handed to the single UPDATE's `.set(...)`. */
const setArg = () => mockUpdateSet.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.mockReturnValue([]);
});

describe('updateEntry — linkage provenance on album_id', () => {
  it('stamps dj_bin_pick when the patch sets a non-null album_id', async () => {
    mockPreRead.mockReturnValue([track({ album_id: 9, linkage_source: 'direct_text_match' })]);
    await updateEntry(7, { album_id: 42 });
    expect(setArg()).toMatchObject({ album_id: 42, linkage_source: 'dj_bin_pick', linkage_confidence: null });
    expect(setArg().linked_at).toBeDefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('keeps rule precedence: a pick wins over a carried album_title and never calls the matcher', async () => {
    mockPreRead.mockReturnValue([track({ album_id: 9, linkage_source: 'direct_text_match' })]);
    mockLookup.mockReturnValue([{ id: 5 }]);
    await updateEntry(7, { album_id: 42, album_title: 'x' });
    expect(setArg()).toMatchObject({ album_id: 42, linkage_source: 'dj_bin_pick', linkage_confidence: null });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('clears all three linkage columns when the patch sets album_id: null', async () => {
    mockPreRead.mockReturnValue([track({ album_id: 9, linkage_source: 'dj_bin_pick' })]);
    await updateEntry(7, { album_id: null });
    expect(setArg()).toEqual({ album_id: null, ...CLEARED });
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe('updateEntry — text re-match on an artist/album edit', () => {
  it.each([
    {
      name: 'one candidate on an unlinked track links it',
      row: track(),
      candidates: [{ id: 5 }],
      expected: { album_id: 5, linkage_source: 'direct_text_match', linkage_confidence: 1 },
    },
    {
      name: 'an artist_name edit with one candidate links an unlinked track',
      row: track(),
      patch: { artist_name: 'Jessica Pratt Band' },
      candidates: [{ id: 5 }],
      expected: { album_id: 5, linkage_source: 'direct_text_match', linkage_confidence: 1 },
    },
    {
      name: 'an artist_name edit with one candidate relinks a direct_text_match track',
      row: track({ album_id: 9, linkage_source: 'direct_text_match' }),
      patch: { artist_name: 'Jessica Pratt Band' },
      candidates: [{ id: 5 }],
      expected: { album_id: 5, linkage_source: 'direct_text_match', linkage_confidence: 1 },
    },
    {
      name: 'one candidate on a direct_text_match row relinks it',
      row: track({ album_id: 9, linkage_source: 'direct_text_match' }),
      candidates: [{ id: 5 }],
      expected: { album_id: 5, linkage_source: 'direct_text_match', linkage_confidence: 1 },
    },
    {
      name: 'no candidate on a direct_text_match row clears the link',
      row: track({ album_id: 9, linkage_source: 'direct_text_match' }),
      candidates: [],
      expected: { album_id: null, ...CLEARED },
    },
    {
      name: 'several candidates including the current album_id leave the link untouched',
      row: track({ album_id: 9, linkage_source: 'direct_text_match' }),
      candidates: [{ id: 5 }, { id: 9 }],
      expected: null,
    },
    {
      name: 'several candidates excluding the current album_id clear the link',
      row: track({ album_id: 9, linkage_source: 'direct_text_match' }),
      candidates: [{ id: 5 }, { id: 6 }],
      expected: { album_id: null, ...CLEARED },
    },
    {
      name: 'several candidates on an unlinked track stay unlinked',
      row: track(),
      candidates: [{ id: 5 }, { id: 6 }],
      expected: { album_id: null, ...CLEARED },
    },
  ])('$name', async ({ row, candidates, expected, patch = { album_title: 'Quiet Signs (Deluxe)' } }) => {
    mockPreRead.mockReturnValue([row]);
    mockLookup.mockReturnValue(candidates);
    await updateEntry(7, patch);
    expect(mockLookup).toHaveBeenCalledTimes(1);
    const set = setArg();
    expect(set).toMatchObject(patch);
    if (expected === null) {
      expect(set).not.toHaveProperty('album_id');
      expect(set).not.toHaveProperty('linkage_source');
    } else {
      expect(set).toMatchObject(expected);
    }
  });

  it.each([
    ['a dj_bin_pick row', track({ album_id: 9, linkage_source: 'dj_bin_pick' }), { album_title: 'x' }],
    ['an etl_legacy_id row', track({ album_id: 9, linkage_source: 'etl_legacy_id' }), { album_title: 'x' }],
    ['a NULL-source row with an album_id', track({ album_id: 9 }), { artist_name: 'x' }],
    ['a talkset', track({ entry_type: 'talkset' }), { artist_name: 'x' }],
    ['a patch touching neither artist nor album', track(), { track_title: 'x' }],
    [
      'a patch carrying unchanged artist/album plus a track_title change',
      track({ album_id: 9, linkage_source: 'direct_text_match' }),
      { artist_name: 'Jessica Pratt', album_title: 'Quiet Signs', track_title: 'x' },
    ],
    [
      'a patch carrying unchanged artist/album plus a request_flag toggle',
      track({ album_id: 9, linkage_source: 'direct_text_match' }),
      { artist_name: 'Jessica Pratt', album_title: 'Quiet Signs', request_flag: true },
    ],
  ])('never calls the matcher or touches the link on %s', async (_name, row, patch) => {
    mockPreRead.mockReturnValue([row]);
    await updateEntry(7, patch);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(setArg()).not.toHaveProperty('linkage_source');
    expect(setArg()).not.toHaveProperty('album_id');
  });

  it('matches on the locked row merged with the patch, not the patch alone', async () => {
    mockPreRead.mockReturnValue([track()]);
    mockLookup.mockReturnValue([{ id: 5 }]);
    await updateEntry(7, { album_title: 'Quiet Signs (Deluxe)' });
    const { params } = new PgDialect().sqlToQuery(mockLookupWhere.mock.calls[0][0]);
    // Album leg then artist leg, each twice: the patched title and the locked row's artist.
    expect(params).toEqual(['Quiet Signs (Deluxe)', 'Jessica Pratt', 'Quiet Signs (Deluxe)', 'Jessica Pratt']);
  });

  it('looks up an artist-only patch with the patched artist and the locked album title', async () => {
    mockPreRead.mockReturnValue([track()]);
    mockLookup.mockReturnValue([{ id: 5 }]);
    await updateEntry(7, { artist_name: 'Jessica Pratt Band' });
    const { params } = new PgDialect().sqlToQuery(mockLookupWhere.mock.calls[0][0]);
    expect(params).toEqual(['Quiet Signs', 'Jessica Pratt Band', 'Quiet Signs', 'Jessica Pratt Band']);
  });

  it('applies the text edit and leaves the link alone when the lookup rejects, reporting to Sentry', async () => {
    const boom = new Error('lookup failed');
    mockPreRead.mockReturnValue([track({ album_id: 9, linkage_source: 'direct_text_match' })]);
    mockLookup.mockImplementation(() => {
      throw boom;
    });
    await expect(updateEntry(7, { album_title: 'Quiet Signs (Deluxe)' })).resolves.toEqual({ id: 7 });
    expect(setArg()).toEqual({ album_title: 'Quiet Signs (Deluxe)' });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, {
      tags: { tool: 'flowsheet', subsystem: 'text-linkage' },
      extra: { entry_id: 7 },
    });
  });
});

describe('updateEntry — transaction shape', () => {
  it('pre-reads the row FOR UPDATE', async () => {
    mockPreRead.mockReturnValue([track()]);
    await updateEntry(7, { track_title: 'x' });
    expect(mockForLock).toHaveBeenCalledWith('update');
  });

  it('returns undefined without updating when the row is gone', async () => {
    mockPreRead.mockReturnValue([]);
    await expect(updateEntry(7, { track_title: 'x' })).resolves.toBeUndefined();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
