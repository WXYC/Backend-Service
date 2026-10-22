/**
 * `updateEntry` on a spotlight row (BS#3459, epic BS#3445).
 *
 * A misspelled band is fixed in its row, so the row keeps its timestamp and play order. Inside the locked row
 * transaction the service merges the patch with the stored role and name and recomposes `message`; a client-sent
 * `message` never survives on a spotlight row. Two cross-type rules keep a spotlight from being mistaken for a play:
 * spotlight fields on any other row type, and track fields on a spotlight row, both answer 400.
 */

jest.unmock('drizzle-orm');

const mockPreRead = jest.fn();
const mockUpdateSet = jest.fn();

/** A thenable drizzle-shaped chain: every builder method returns it, and awaiting it yields `result()`. */
const chain = (result: () => unknown, hooks: Record<string, (...args: any[]) => void> = {}) => {
  const c: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'then') {
          return (resolve: any, reject: any) => Promise.resolve().then(result).then(resolve, reject);
        }
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
    select: () => chain(() => mockPreRead()),
    update: () => chain(() => [{ id: 7 }], { set: (...args) => mockUpdateSet(...args) }),
    transaction: (cb: (sp: unknown) => unknown) => Promise.resolve().then(() => cb({})),
  };
  const scriptedDb = { transaction: (cb: (t: typeof trx) => unknown) => Promise.resolve(cb(trx)) };
  return jest.requireActual('../../utils/real-database-module').realDatabaseModule({ db: scriptedDb });
});

import type { UpdateRequestBody } from '../../../apps/backend/controllers/flowsheet.controller';
import { updateEntry } from '../../../apps/backend/services/flowsheet.service';

const spotlight = (over: Record<string, unknown> = {}) => ({
  entry_type: 'spotlight',
  artist_name: '',
  album_title: '',
  album_id: null,
  linkage_source: null,
  spotlight_role: 'guest',
  spotlight_name: 'Weirz',
  ...over,
});

const track = () => ({
  entry_type: 'track',
  artist_name: 'Jessica Pratt',
  album_title: 'Quiet Signs',
  album_id: null,
  linkage_source: null,
  spotlight_role: null,
  spotlight_name: null,
});

const setArg = () => mockUpdateSet.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateEntry — spotlight rows', () => {
  it.each<[string, UpdateRequestBody, string]>([
    ['name only', { spotlight_name: 'Weirs' }, 'In the studio: Weirs'],
    ['role only', { spotlight_role: 'reader' }, 'Reading now: Weirz'],
    ['both', { spotlight_role: 'dj', spotlight_name: 'Weirs' }, 'Now mixing: Weirs'],
    ['performer', { spotlight_role: 'performer' }, 'Live in the studio: Weirz'],
    ['host', { spotlight_role: 'host' }, 'Live in the studio: Weirz'],
  ])('%s: merges with the stored values and recomposes message', async (_label, patch, message) => {
    mockPreRead.mockReturnValue([spotlight()]);

    await updateEntry(7, patch, null);

    expect(setArg()).toMatchObject({ ...patch, message });
  });

  it('replaces a client-sent message with the composed one', async () => {
    mockPreRead.mockReturnValue([spotlight()]);

    await updateEntry(7, { spotlight_name: 'Weirs', message: 'hand-typed' }, null);

    expect(setArg().message).toBe('In the studio: Weirs');
  });

  it.each([
    ['artist_name', 'x'],
    ['album_title', 'x'],
    ['track_title', 'x'],
    ['album_id', 3],
    ['rotation_id', 3],
    ['record_label', 'Sonamos'],
    ['label_id', 3],
    ['track_position', 'A1'],
    ['request_flag', false],
    ['segue', false],
  ])('rejects %s on a spotlight row with 400 and writes nothing', async (field, value) => {
    mockPreRead.mockReturnValue([spotlight()]);

    await expect(updateEntry(7, { [field]: value }, null)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it.each([
    ['spotlight_role', 'guest'],
    ['spotlight_name', 'Weirs'],
  ])('rejects %s on a track row with 400 and writes nothing', async (field, value) => {
    mockPreRead.mockReturnValue([track()]);

    await expect(updateEntry(7, { [field]: value }, null)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
