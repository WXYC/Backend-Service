/**
 * Guards for `refileArtistInGenre` (BS#2643) in `apps/backend/services/library.service.ts`.
 *
 * The shared `createMockDb().transaction` calls back with the mock db itself, so `tx === db` there and an
 * assertion that "the lock ran on the transaction" could never fail. Every test here hands the callback a DISTINCT
 * `tx` stand-in and makes `db.select` throw, so a statement issued on the pool instead of the transaction (where
 * `FOR UPDATE` would autocommit and release at once) fails loudly on every branch.
 */
import { jest } from '@jest/globals';
import { artists, db, genre_artist_crossreference, library } from '@wxyc/database';

type Call = { op: string; methods: string[]; table?: unknown };

const pgError = (code: string): Error => Object.assign(new Error('pg'), { code });

const CARD = {
  artist_id: 431,
  artist_name: 'Isis',
  alphabetical_name: 'Isis',
  genre_id: 6,
  code_letters: 'IS',
  code_artist_number: 1,
  code_comp_letter: null,
};

/** Rows for the four `select`s a full run issues, in order: artists-row lock, card, bucket lock, owners. */
const makeTx = (opts: {
  selects: unknown[][];
  countRow?: number;
  /** Results of the `LIMIT 1` probes in the order they run: stray-release (letters change), then destination (move). */
  probes?: boolean[];
  updateRows?: unknown[];
  throwOnSelect?: number;
  error?: unknown;
}) => {
  const calls: Call[] = [];
  let selectIndex = 0;
  const probes = [...(opts.probes ?? [])];
  const chain = (call: Call, result: unknown[], boom?: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
      c[m] = () => {
        call.methods.push(m);
        return c;
      };
    }
    c.for = (mode: string) => {
      call.methods.push(`for(${mode})`);
      return c;
    };
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => (boom ? reject(boom) : resolve(result));
    return c;
  };
  const tx = {
    select: () => {
      const call: Call = { op: 'select', methods: [] };
      calls.push(call);
      const i = selectIndex++;
      return chain(call, opts.selects[i] ?? [], opts.throwOnSelect === i ? opts.error : undefined);
    },
    update: (table: unknown) => {
      const call: Call = { op: 'update', methods: [], table };
      calls.push(call);
      const c: Record<string, unknown> = {};
      c.set = () => c;
      c.where = () =>
        Object.assign(Promise.resolve([]), {
          returning: () => Promise.resolve(opts.updateRows ?? [{ id: 1 }, { id: 2 }]),
        });
      return c;
    },
    execute: (query: { sql?: string[] }) => {
      const text = (query.sql ?? []).join('?');
      // Keyed on distinctive statement tokens, not on any operator: the advisory lock, the release count, the
      // stray-release probe (the only other `library` read), and the SET LOCAL lock_timeout (neither of those).
      const op = text.includes('pg_advisory_xact_lock')
        ? 'advisory'
        : text.includes('count(*)')
          ? 'count'
          : text.includes('LIMIT 1')
            ? 'stray'
            : text.includes('FOR NO KEY UPDATE')
              ? 'lockLibrary'
              : 'other';
      calls.push({ op, methods: [] });
      if (op === 'advisory' || op === 'other') return Promise.resolve([]);
      if (op === 'stray') return Promise.resolve(probes.shift() ? [{ '?column?': 1 }] : []);
      if (op === 'lockLibrary') return Promise.resolve([]);
      return Promise.resolve([{ n: opts.countRow ?? 2 }]);
    },
  };
  return { tx, calls };
};

const run = async (opts: Parameters<typeof makeTx>[0], target = 31, codeLetters?: string, toGenre?: number) => {
  const { tx, calls } = makeTx(opts);
  const dbSelect = jest.fn(() => {
    throw new Error('db.select must not be used inside refileArtistInGenre');
  });
  (db as unknown as Record<string, unknown>).select = dbSelect;
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const { refileArtistInGenre } = await import('../../../apps/backend/services/library.service');
  const outcome = await refileArtistInGenre(431, 6, target, codeLetters, toGenre);
  return { outcome, calls, dbSelect };
};

/** The `artists` row the first statement locks. */
const A = [{ id: 431 }];

const BUCKET = (n: number, comp: string | null = null) => [
  { artist_id: 100, genre_id: 6, code_number: 4, code_comp_letter: null },
  { artist_id: 431, genre_id: 6, code_number: n, code_comp_letter: comp },
];

describe('refileArtistInGenre (BS#2643)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refiles: locks the bucket on tx FOR UPDATE ordered, reads owners on tx, updates, counts', async () => {
    const { outcome, calls, dbSelect } = await run({ selects: [A, [CARD], BUCKET(1), []] });

    expect(outcome).toMatchObject({
      outcome: 'refiled',
      previous: 1,
      releases_to_relabel: 2,
      card: { artist_id: 431, code_artist_number: 31 },
    });
    expect(dbSelect).not.toHaveBeenCalled();
    const selects = calls.filter((c) => c.op === 'select');
    expect(selects).toHaveLength(4);
    // The artists row is locked first, alone (no join), NO KEY UPDATE, before the card is read.
    expect(selects[0].methods).toEqual(['from', 'where', 'for(no key update)']);
    expect(selects[1].methods).toContain('innerJoin');
    expect(selects[1].methods).not.toContain('for(no key update)');
    expect(selects[2].methods).toEqual(['from', 'where', 'orderBy', 'for(update)']);
    expect(selects[2].methods).not.toContain('innerJoin');
    expect(selects[3].methods).toContain('innerJoin');
    expect(selects[3].methods).not.toContain('for(update)');
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(1);
    // The advisory lock is taken on tx after the card read and before the bucket lock; no stray-release probe runs
    // without a letters change.
    // (index 0 is the SET LOCAL lock_timeout)
    expect(calls.map((c) => c.op).slice(1, 5)).toEqual(['select', 'select', 'advisory', 'select']);
    expect(calls.some((c) => c.op === 'stray')).toBe(false);
  });

  describe('re-lettering', () => {
    const OWN_JA = [
      { artist_id: 100, genre_id: 6, code_number: 4, code_comp_letter: null },
      { artist_id: 431, genre_id: 6, code_number: 1, code_comp_letter: null },
    ];

    it('writes the normalized letters, then the number; reports the previous letters', async () => {
      const { outcome, calls, dbSelect } = await run({ selects: [A, [CARD], OWN_JA, []] }, 31, 'JA');

      expect(outcome).toMatchObject({
        outcome: 'refiled',
        previous: 1,
        previous_letters: 'IS',
        card: { code_letters: 'JA', code_artist_number: 31 },
      });
      expect(calls.filter((c) => c.op === 'update')).toHaveLength(2);
      expect(calls.some((c) => c.op === 'stray')).toBe(true);
      expect(dbSelect).not.toHaveBeenCalled();
    });

    it('sending the stored letters back (any case or spacing) is not a letters change', async () => {
      const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(31)] }, 31, ' is ');

      expect(outcome).toMatchObject({ outcome: 'unchanged', previous_letters: 'IS' });
      expect(calls.some((c) => c.op === 'update' || c.op === 'stray')).toBe(false);
    });

    it('a letters-only change issues just the artists UPDATE', async () => {
      const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(1), []] }, 1, 'JA');

      expect(outcome).toMatchObject({ outcome: 'refiled', card: { code_letters: 'JA' } });
      const updates = calls.filter((c) => c.op === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0].table).toBe(artists);
    });

    it('a number-only change updates only the crossreference', async () => {
      const { calls } = await run({ selects: [A, [CARD], BUCKET(1), []] }, 31);

      expect(calls.filter((c) => c.op === 'update').map((c) => c.table)).toEqual([genre_artist_crossreference]);
    });

    it('refuses with the memberships when more than one membership is locked', async () => {
      const locked = [
        { artist_id: 431, genre_id: 2, code_number: 7, code_comp_letter: null },
        { artist_id: 431, genre_id: 6, code_number: 1, code_comp_letter: null },
      ];
      const { outcome, calls } = await run({ selects: [A, [CARD], locked] }, 31, 'JA');

      expect(outcome).toEqual({
        outcome: 'letters_shared',
        memberships: [
          { genre_id: 2, code_artist_number: 7 },
          { genre_id: 6, code_artist_number: 1 },
        ],
      });
      expect(calls.some((c) => c.op === 'update')).toBe(false);
    });

    it('refuses when the artist has a release in another genre', async () => {
      const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(1)], probes: [true] }, 31, 'JA');

      expect(outcome).toEqual({
        outcome: 'letters_shared',
        memberships: [{ genre_id: 6, code_artist_number: 1 }],
      });
      expect(calls.some((c) => c.op === 'update')).toBe(false);
    });

    it('a multi-genre artist may still re-number without a letters change', async () => {
      const locked = [
        { artist_id: 431, genre_id: 2, code_number: 7, code_comp_letter: null },
        { artist_id: 431, genre_id: 6, code_number: 1, code_comp_letter: null },
      ];
      const { outcome } = await run({ selects: [A, [CARD], locked, []] }, 31);

      expect(outcome).toMatchObject({ outcome: 'refiled' });
    });
  });

  it('unchanged: issues no UPDATE and still counts releases', async () => {
    const { outcome, calls, dbSelect } = await run({ selects: [A, [CARD], BUCKET(31)], countRow: 3 });

    expect(outcome).toMatchObject({ outcome: 'unchanged', previous: 31, releases_to_relabel: 3 });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
    expect(calls.filter((c) => c.op === 'select')).toHaveLength(3);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('slot_taken: names the first other owner as a contract Artist and writes nothing (self in the owner list is filtered as defense in depth; the live guard is the unchanged return)', async () => {
    const owners = [
      { artist_id: 431, artist_name: 'Isis', code_letters: 'IS', code_comp_letter: null },
      { artist_id: 7, artist_name: 'Isis Two', code_letters: 'IS', code_comp_letter: null },
    ];
    const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(1), owners] });

    expect(outcome).toEqual({
      outcome: 'slot_taken',
      occupant: {
        id: 7,
        artist_name: 'Isis Two',
        code_letters: 'IS',
        code_artist_number: 31,
        code_comp_letter: null,
        genre_id: 6,
      },
    });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('lettered_section: refuses before the no-op and occupancy checks', async () => {
    const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(0, 'A')] }, 0);

    expect(outcome).toEqual({ outcome: 'lettered_section' });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it.each([
    ['V/A', 5],
    ['  v/a ', 5],
    ['Z-R', 5],
    ['V/A', 4],
  ])(
    'various_artists_section: refuses code_letters %j with target %i before the no-op, issuing no UPDATE',
    async (codeLetters, target) => {
      const { outcome, calls } = await run(
        { selects: [A, [{ ...CARD, code_letters: codeLetters }], BUCKET(4)] },
        target
      );

      expect(outcome).toEqual({ outcome: 'various_artists_section' });
      expect(calls.some((c) => c.op === 'update')).toBe(false);
      expect(calls.filter((c) => c.op === 'select')).toHaveLength(3);
    }
  );

  it('a lettered V/A section stays lettered_section, not various_artists_section', async () => {
    const { outcome } = await run({ selects: [A, [{ ...CARD, code_letters: 'V/A' }], BUCKET(0, 'A')] }, 0);

    expect(outcome).toEqual({ outcome: 'lettered_section' });
  });

  it('an artist whose name says Various but whose letters are ordinary re-files', async () => {
    const card = { ...CARD, artist_name: 'Various Cruelties', code_letters: 'VA' };
    const { outcome } = await run({ selects: [A, [card], BUCKET(1), []] });

    expect(outcome).toMatchObject({ outcome: 'refiled' });
  });

  it.each([
    ['artist_not_found', [[]], 1],
    ['not_filed', [A, []], 2],
  ])('a miss on tx separates the 404s: %s', async (expected, selects, selectCount) => {
    const { outcome, calls, dbSelect } = await run({ selects });

    expect(outcome).toEqual({ outcome: expected });
    expect(calls.filter((c) => c.op === 'select')).toHaveLength(selectCount);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('row gone from the locked set (concurrent delete): answers not_filed with no further read', async () => {
    const { outcome, dbSelect, calls } = await run({
      selects: [A, [CARD], [{ artist_id: 100, genre_id: 6, code_number: 4, code_comp_letter: null }]],
    });

    expect(outcome).toEqual({ outcome: 'not_filed' });
    expect(calls.filter((c) => c.op === 'select')).toHaveLength(3);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it.each(['55P03', '40P01'])('maps SQLSTATE %s on the bucket lock to lock_unavailable', async (code) => {
    const { outcome } = await run({ selects: [A, [CARD]], throwOnSelect: 2, error: pgError(code) });

    expect(outcome).toEqual({ outcome: 'lock_unavailable' });
  });

  it('maps a lock timeout on the artists-row lock itself to lock_unavailable', async () => {
    const { outcome } = await run({ selects: [A], throwOnSelect: 0, error: pgError('55P03') });

    expect(outcome).toEqual({ outcome: 'lock_unavailable' });
  });

  it('rethrows an unrelated error', async () => {
    await expect(run({ selects: [A, [CARD]], throwOnSelect: 2, error: pgError('23505') })).rejects.toThrow('pg');
  });

  describe('genre move', () => {
    it('moves: locks the releases, then UPDATEs crossreference and library; counts in the destination genre', async () => {
      const { outcome, calls, dbSelect } = await run(
        { selects: [A, [CARD], BUCKET(1), []], probes: [false] },
        4,
        undefined,
        7
      );

      expect(outcome).toMatchObject({
        outcome: 'refiled',
        previous: 1,
        previous_genre_id: 6,
        card: { genre_id: 7, code_artist_number: 4 },
      });
      const ops = calls.map((c) => c.op);
      // Release rows are locked before the first UPDATE (the watermark stays the last lock taken).
      expect(ops.indexOf('lockLibrary')).toBeGreaterThan(-1);
      expect(ops.indexOf('lockLibrary')).toBeLessThan(ops.indexOf('update'));
      expect(calls.filter((c) => c.op === 'update').map((c) => c.table)).toEqual([
        genre_artist_crossreference,
        library,
      ]);
      expect(dbSelect).not.toHaveBeenCalled();
    });

    it('a destination equal to the source is no move', async () => {
      const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(31)] }, 31, undefined, 6);

      expect(outcome).toMatchObject({ outcome: 'unchanged' });
      expect(calls.some((c) => c.op === 'lockLibrary' || c.op === 'update')).toBe(false);
    });

    it('refuses already_filed when a membership exists at the destination, writing nothing', async () => {
      const locked = [...BUCKET(1), { artist_id: 431, genre_id: 7, code_number: 2, code_comp_letter: null }];
      const { outcome, calls } = await run({ selects: [A, [CARD], locked], probes: [false] }, 4, undefined, 7);

      expect(outcome).toEqual({ outcome: 'already_filed' });
      expect(calls.some((c) => c.op === 'update' || c.op === 'lockLibrary')).toBe(false);
    });

    it('refuses already_filed when a release sits at the destination without a membership', async () => {
      const { outcome, calls } = await run({ selects: [A, [CARD], BUCKET(1)], probes: [true] }, 4, undefined, 7);

      expect(outcome).toEqual({ outcome: 'already_filed' });
      expect(calls.some((c) => c.op === 'update')).toBe(false);
    });

    it('a move onto an occupied destination slot is slot_taken in the destination genre', async () => {
      const owners = [{ artist_id: 9, artist_name: 'Other', code_letters: 'IS', code_comp_letter: null }];
      const { outcome } = await run({ selects: [A, [CARD], BUCKET(1), owners], probes: [false] }, 4, undefined, 7);

      expect(outcome).toMatchObject({ outcome: 'slot_taken', occupant: { id: 9, genre_id: 7 } });
    });

    it('letters_shared applies only to a letters change: a multi-membership artist with a stray release still moves', async () => {
      const locked = [
        { artist_id: 431, genre_id: 2, code_number: 7, code_comp_letter: null },
        { artist_id: 431, genre_id: 6, code_number: 1, code_comp_letter: null },
      ];
      // Probes: the destination probe only (no stray probe runs without a letters change).
      const { outcome, calls } = await run({ selects: [A, [CARD], locked, []], probes: [false] }, 4, undefined, 7);

      expect(outcome).toMatchObject({ outcome: 'refiled', card: { genre_id: 7 } });
      expect(calls.filter((c) => c.op === 'update').map((c) => c.table)).toEqual([
        genre_artist_crossreference,
        library,
      ]);
    });

    it('logs the genre change with the number of releases moved', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await run(
        { selects: [A, [CARD], BUCKET(1), []], probes: [false], updateRows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        4,
        undefined,
        7
      );

      const line = log.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('[library.refile]'));
      log.mockRestore();
      expect(JSON.parse(String(line).replace('[library.refile] ', ''))).toMatchObject({
        before: { genre_id: 6 },
        after: { genre_id: 7, code_artist_number: 4 },
        releases_moved: 3,
      });
    });

    it.each([
      ['artist_genre_key', 'already_filed'],
      ['some_other_unique', undefined],
    ])('maps a 23505 on %s', async (constraint, expected) => {
      const err = Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint_name: constraint } });
      const { tx } = makeTx({ selects: [A, [CARD], BUCKET(1), []], probes: [false] });
      (tx as { update: unknown }).update = () => {
        throw err;
      };
      (db as unknown as { transaction: unknown }).transaction = jest
        .fn()
        .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
      const { refileArtistInGenre } = await import('../../../apps/backend/services/library.service');

      const result = refileArtistInGenre(431, 6, 4, undefined, 7);

      if (expected) await expect(result).resolves.toEqual({ outcome: expected });
      else await expect(result).rejects.toBe(err);
    });
  });

  describe('Various Artists destination', () => {
    it.each(['V/A', ' v/a ', 'v/a'])(
      'rejects code_letters %j with a 400 before opening a transaction',
      async (letters) => {
        const tx = jest.fn();
        (db as unknown as { transaction: unknown }).transaction = tx;
        const { refileArtistInGenre } = await import('../../../apps/backend/services/library.service');

        await expect(refileArtistInGenre(431, 6, 31, letters)).rejects.toMatchObject({ statusCode: 400 });
        expect(tx).not.toHaveBeenCalled();
      }
    );
  });

  describe('[library.refile] log line', () => {
    let log: jest.SpiedFunction<typeof console.log>;
    beforeEach(() => {
      log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => log.mockRestore());

    const lines = () => log.mock.calls.filter(([m]) => String(m).startsWith('[library.refile]'));

    it('logs once, with before/after, on a write', async () => {
      await run({ selects: [A, [CARD], BUCKET(1), []] }, 31, 'JA');

      expect(lines()).toHaveLength(1);
      const record = JSON.parse(String(lines()[0][0]).replace('[library.refile] ', ''));
      expect(record).toEqual({
        artist_id: 431,
        before: { code_letters: 'IS', genre_id: 6, code_artist_number: 1 },
        after: { code_letters: 'JA', genre_id: 6, code_artist_number: 31 },
        releases_moved: 0,
      });
    });

    it('does not log on a no-op', async () => {
      await run({ selects: [A, [CARD], BUCKET(31)] }, 31, 'is');

      expect(lines()).toHaveLength(0);
    });

    it('does not log when the transaction fails after the write', async () => {
      const { tx } = makeTx({ selects: [A, [CARD], BUCKET(1), []] });
      (tx as { execute: unknown }).execute = jest.fn((q: { sql?: string[] }) => {
        const text = (q.sql ?? []).join('?');
        return text.includes('count(*)') ? Promise.reject(new Error('boom')) : Promise.resolve([]);
      });
      (db as unknown as { transaction: unknown }).transaction = jest
        .fn()
        .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
      const { refileArtistInGenre } = await import('../../../apps/backend/services/library.service');

      await expect(refileArtistInGenre(431, 6, 31)).rejects.toThrow('boom');
      expect(lines()).toHaveLength(0);
    });
  });
});
