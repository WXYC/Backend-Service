import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';
import { db, type SpecialtyShows } from '@wxyc/database';
import { toSpecialtyShowRef } from '../../../apps/backend/services/flowsheet/specialty-ref';
import {
  assertSpecialtyTaggable,
  isSpecialtyShowTaggable,
  toSpecialtyShow,
} from '../../../apps/backend/services/specialty-shows.service';

const ROW = {
  id: 3,
  specialty_name: 'Sonic Landscapes',
  description: 'internal',
  add_date: '2026-01-01',
  last_modified: new Date('2026-01-01T00:00:00Z'),
  slug: 'sonic-landscapes',
  short_name: 'Landscapes',
  tagline: null,
  logs_playcuts: false,
  default_spotlight_role: 'host',
  artwork: { square_url: 's', master_url: 'm', wide_url: 'w' },
  accent_color: '#112233',
  default_request_mode: 'feedback',
  slots: [{ day: 1 }],
  active: false,
} as unknown as SpecialtyShows;

describe('toSpecialtyShow', () => {
  it('is the ref plus default_request_mode, description, slots and active', () => {
    expect(toSpecialtyShow(ROW)).toEqual({
      ...toSpecialtyShowRef(ROW),
      default_request_mode: 'feedback',
      description: 'internal',
      slots: [{ day: 1 }],
      active: false,
    });
  });
});

const catalogLimit = (db as unknown as { _chain: { limit: jest.Mock<() => Promise<unknown>> } })._chain.limit;
const selectCalls = () => (db.select as unknown as jest.Mock).mock.calls.length;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isSpecialtyShowTaggable', () => {
  it.each([
    ['an active program', [{ id: 7 }], true],
    ['an inactive or unknown id', [], false],
  ])('is %s -> %s', async (_name, rows, expected) => {
    catalogLimit.mockResolvedValue(rows);
    await expect(isSpecialtyShowTaggable(7)).resolves.toBe(expected);
  });
});

describe('assertSpecialtyTaggable', () => {
  it.each([[null], [undefined]])('passes %s without reading the catalog', async (id) => {
    await expect(assertSpecialtyTaggable(id)).resolves.toBeUndefined();
    expect(selectCalls()).toBe(0);
  });

  it.each([[0], [-3], [2 ** 31], [7.5], [true], ['7']])(
    'rejects the out-of-bounds specialty_id %p with 400 before any catalog read',
    async (bad) => {
      await expect(assertSpecialtyTaggable(bad as unknown as number)).rejects.toMatchObject({ statusCode: 400 });
      expect(selectCalls()).toBe(0);
    }
  );

  it('accepts the largest int4 id when the program is taggable', async () => {
    catalogLimit.mockResolvedValue([{ id: 2 ** 31 - 1 }]);
    await expect(assertSpecialtyTaggable(2 ** 31 - 1)).resolves.toBeUndefined();
  });

  it('accepts a valid active id', async () => {
    catalogLimit.mockResolvedValue([{ id: 7 }]);
    await expect(assertSpecialtyTaggable(7)).resolves.toBeUndefined();
    expect(selectCalls()).toBe(1);
  });

  it('rejects an inactive or unknown id with 400', async () => {
    catalogLimit.mockResolvedValue([]);
    await expect(assertSpecialtyTaggable(999)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets a show keep its own retired program's id without a catalog read", async () => {
    await expect(assertSpecialtyTaggable(7, 7)).resolves.toBeUndefined();
    expect(selectCalls()).toBe(0);
  });
});

describe('specialty module graph (no import cycle with flowsheet.service)', () => {
  it.each([
    ['flowsheet/specialty-ref', /from '\.\.?\/(flowsheet|specialty-shows)\.service/],
    ['specialty-shows.service', /from '\.\/flowsheet\.service/],
  ])('%s does not import the services that import it', (file, forbidden) => {
    const source = readFileSync(require.resolve(`../../../apps/backend/services/${file}`), 'utf8');
    expect(source).not.toMatch(forbidden);
  });
});
