const CODE_LETTERS_SENTINEL = Symbol('artists.code_letters');
const CODE_ARTIST_NUMBER_SENTINEL = Symbol('artists.code_artist_number');

const mockSelect = jest.fn().mockReturnThis();
const mockFrom = jest.fn().mockReturnThis();
const mockInnerJoin = jest.fn().mockReturnThis();
const mockWhere = jest.fn().mockReturnThis();
const mockLimit = jest.fn().mockResolvedValue([
  {
    id: 1,
    code_letters: 'RO',
    code_artist_number: 42,
    code_number: 1,
    artist_name: 'Test Artist',
    album_title: 'Test Album',
    record_label: 'Test Label',
    plays: 0,
    add_date: '2024-01-01',
    last_modified: new Date(),
  },
]);

jest.mock('@wxyc/database', () => ({
  db: {
    select: mockSelect,
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  },
  library: { id: 'lib.id', code_number: 'lib.code_number', album_title: 'lib.album_title', label: 'lib.label', plays: 'lib.plays', add_date: 'lib.add_date', last_modified: 'lib.last_modified', artist_id: 'lib.artist_id' },
  artists: {
    id: 'artists.id',
    code_letters: CODE_LETTERS_SENTINEL,
    code_artist_number: CODE_ARTIST_NUMBER_SENTINEL,
    artist_name: 'artists.artist_name',
  },
  genres: {},
  format: {},
  rotation: {},
  library_artist_view: {},
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
  desc: jest.fn((col) => ({ desc: col })),
}));

import { getAlbumFromDB } from '../../../apps/backend/services/library.service';

describe('getAlbumFromDB', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
    mockInnerJoin.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('selects artists.code_artist_number for the code_artist_number field', async () => {
    await getAlbumFromDB(1);

    const selectArg = mockSelect.mock.calls[0][0];
    expect(selectArg.code_artist_number).toBe(CODE_ARTIST_NUMBER_SENTINEL);
  });
});
