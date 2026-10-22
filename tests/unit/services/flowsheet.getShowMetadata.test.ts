import { db, createMockQueryChain } from '../../mocks/database.mock';
import { getShowMetadata } from '../../../apps/backend/services/flowsheet.service';

describe('getShowMetadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns undefined when show_id does not exist — controller maps this to 404 (BS#1113)', async () => {
    const showSelect = createMockQueryChain();
    showSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showSelect);

    const result = await getShowMetadata(999999999);

    expect(result).toBeUndefined();
  });

  it('does not query DJs or the specialty show once the show lookup comes back empty', async () => {
    const showSelect = createMockQueryChain();
    showSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showSelect);

    await getShowMetadata(999999999);

    // The only db.select call should be the show lookup itself — no
    // show_djs/user (getDJsInShow) or specialty_shows follow-up queries.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns show metadata with DJs and specialty name when the show exists', async () => {
    const showSelect = createMockQueryChain();
    showSelect.where.mockResolvedValue([{ id: 42, specialty_id: 7, show_name: 'Test Show' }]);
    db.select.mockReturnValueOnce(showSelect);

    // getDJsInShow(show_id, false): show_djs select, then user select
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.where.mockResolvedValue([{ dj_id: 'user-1', active: true }]);
    db.select.mockReturnValueOnce(showDjsSelect);

    const userSelect = createMockQueryChain();
    userSelect.where.mockResolvedValue([{ id: 'user-1', djName: 'DJ Test' }]);
    db.select.mockReturnValueOnce(userSelect);

    // specialty_shows select
    const specialtySelect = createMockQueryChain();
    specialtySelect.where.mockResolvedValue([
      { id: 7, specialty_name: 'Jazz Hour', slug: 'jazz-hour', short_name: 'Jazz' },
    ]);
    db.select.mockReturnValueOnce(specialtySelect);

    const result = await getShowMetadata(42);

    expect(result).toEqual(
      expect.objectContaining({
        id: 42,
        specialty_id: 7,
        show_name: 'Test Show',
        specialty_show_name: 'Jazz Hour',
        specialty: expect.objectContaining({ id: 7, slug: 'jazz-hour', name: 'Jazz Hour', short_name: 'Jazz' }),
        show_djs: [{ id: 'user-1', dj_name: 'DJ Test', active: true }],
      })
    );
  });

  // BS#3612: each show_djs item carries the membership flag; rows and order are the user query's.
  it.each([
    [
      'an active member',
      [{ dj_id: 'u1', active: true }],
      [{ id: 'u1', djName: 'A' }],
      [{ id: 'u1', dj_name: 'A', active: true }],
    ],
    [
      'a departed member',
      [{ dj_id: 'u1', active: false }],
      [{ id: 'u1', djName: 'A' }],
      [{ id: 'u1', dj_name: 'A', active: false }],
    ],
    [
      'a mix, in the user query order',
      [
        { dj_id: 'u1', active: true },
        { dj_id: 'u2', active: false },
      ],
      [
        { id: 'u2', djName: 'B' },
        { id: 'u1', djName: 'A' },
      ],
      [
        { id: 'u2', dj_name: 'B', active: false },
        { id: 'u1', dj_name: 'A', active: true },
      ],
    ],
    ['no membership rows', [], [], []],
  ])('emits active for %s', async (_label, memberships, users, expected) => {
    const showSelect = createMockQueryChain();
    showSelect.where.mockResolvedValue([{ id: 42, specialty_id: null, show_name: 'S' }]);
    db.select.mockReturnValueOnce(showSelect);
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.where.mockResolvedValue(memberships);
    db.select.mockReturnValueOnce(showDjsSelect);
    if (users.length > 0) {
      const userSelect = createMockQueryChain();
      userSelect.where.mockResolvedValue(users);
      db.select.mockReturnValueOnce(userSelect);
    }

    const result = await getShowMetadata(42);

    expect(result?.show_djs).toEqual(expected);
  });
});
