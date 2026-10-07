/**
 * Guards for `refileArtistInGenre` (BS#2643) in `apps/backend/services/library.service.ts`.
 *
 * The shared `createMockDb().transaction` calls back with the mock db itself, so `tx === db` there and an
 * assertion that "the lock ran on the transaction" could never fail. Every test here hands the callback a DISTINCT
 * `tx` stand-in and makes `db.select` throw, so a statement issued on the pool instead of the transaction (where
 * `FOR UPDATE` would autocommit and release at once) fails loudly on every branch.
 */
import { jest } from '@jest/globals';
import { db } from '@wxyc/database';

type Call = { op: string; methods: string[] };

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

/** Rows for the three `select`s a full run issues, in order: card, bucket lock, owners (a miss issues one more). */
const makeTx = (opts: { selects: unknown[][]; countRow?: number; throwOnSelect?: number; error?: unknown }) => {
  const calls: Call[] = [];
  let selectIndex = 0;
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
    update: () => {
      const call: Call = { op: 'update', methods: [] };
      calls.push(call);
      const c: Record<string, unknown> = {};
      c.set = () => c;
      c.where = () => Promise.resolve([]);
      return c;
    },
    execute: () => {
      calls.push({ op: 'execute', methods: [] });
      return Promise.resolve([{ n: opts.countRow ?? 2 }]);
    },
  };
  return { tx, calls };
};

const run = async (opts: Parameters<typeof makeTx>[0], target = 31) => {
  const { tx, calls } = makeTx(opts);
  const dbSelect = jest.fn(() => {
    throw new Error('db.select must not be used inside refileArtistInGenre');
  });
  (db as unknown as Record<string, unknown>).select = dbSelect;
  (db as unknown as { transaction: unknown }).transaction = jest
    .fn()
    .mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const { refileArtistInGenre } = await import('../../../apps/backend/services/library.service');
  const outcome = await refileArtistInGenre(431, 6, target);
  return { outcome, calls, dbSelect };
};

const BUCKET = (n: number, comp: string | null = null) => [
  { artist_id: 100, code_number: 4, code_comp_letter: null },
  { artist_id: 431, code_number: n, code_comp_letter: comp },
];

describe('refileArtistInGenre (BS#2643)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refiles: locks the bucket on tx FOR UPDATE ordered, reads owners on tx, updates, counts', async () => {
    const { outcome, calls, dbSelect } = await run({ selects: [[CARD], BUCKET(1), []] });

    expect(outcome).toMatchObject({
      outcome: 'refiled',
      previous: 1,
      releases_to_relabel: 2,
      card: { artist_id: 431, code_artist_number: 31 },
    });
    expect(dbSelect).not.toHaveBeenCalled();
    const selects = calls.filter((c) => c.op === 'select');
    expect(selects).toHaveLength(3);
    expect(selects[1].methods).toEqual(['from', 'where', 'orderBy', 'for(update)']);
    expect(selects[1].methods).not.toContain('innerJoin');
    expect(selects[2].methods).toContain('innerJoin');
    expect(selects[2].methods).not.toContain('for(update)');
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(1);
  });

  it('unchanged: issues no UPDATE and still counts releases', async () => {
    const { outcome, calls, dbSelect } = await run({ selects: [[CARD], BUCKET(31)], countRow: 3 });

    expect(outcome).toMatchObject({ outcome: 'unchanged', previous: 31, releases_to_relabel: 3 });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
    expect(calls.filter((c) => c.op === 'select')).toHaveLength(2);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('slot_taken: names the first other owner as a contract Artist and writes nothing (self in the owner list is filtered as defense in depth; the live guard is the unchanged return)', async () => {
    const owners = [
      { artist_id: 431, artist_name: 'Isis', code_letters: 'IS', code_comp_letter: null },
      { artist_id: 7, artist_name: 'Isis Two', code_letters: 'IS', code_comp_letter: null },
    ];
    const { outcome, calls } = await run({ selects: [[CARD], BUCKET(1), owners] });

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
    const { outcome, calls } = await run({ selects: [[CARD], BUCKET(0, 'A')] }, 0);

    expect(outcome).toEqual({ outcome: 'lettered_section' });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it.each([
    ['not_filed', [{ artist_id: 431, artist_name: 'Isis', code_letters: 'IS' }]],
    ['artist_not_found', []],
  ])('unlocked-read miss separates the 404s on tx (%s)', async (expected, byId) => {
    const { outcome, dbSelect } = await run({ selects: [[], byId] });

    expect(outcome).toEqual({ outcome: expected });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('row gone from the locked set (concurrent delete): answers not_filed via getArtistById on tx', async () => {
    const { outcome, dbSelect } = await run({
      selects: [[CARD], [{ artist_id: 100, code_number: 4, code_comp_letter: null }], [{ artist_id: 431 }]],
    });

    expect(outcome).toEqual({ outcome: 'not_filed' });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it.each(['55P03', '40P01'])('maps SQLSTATE %s on the lock to lock_unavailable', async (code) => {
    const { outcome } = await run({ selects: [[CARD]], throwOnSelect: 1, error: pgError(code) });

    expect(outcome).toEqual({ outcome: 'lock_unavailable' });
  });

  it('rethrows an unrelated error', async () => {
    await expect(run({ selects: [[CARD]], throwOnSelect: 1, error: pgError('23505') })).rejects.toThrow('pg');
  });
});
