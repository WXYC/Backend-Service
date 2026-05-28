jest.mock('@wxyc/database', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
  user: { id: 'user.id' },
  user_activity: {
    userId: 'user_activity.userId',
    requestCount: 'user_activity.requestCount',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a, b) => ({ eq: [a, b] })),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: jest.fn((s: string) => ({ raw: s })) }
  ),
}));

import { db } from '@wxyc/database';
import { recordActivity } from '../../../apps/backend/services/activityTracking.service';

const mockDb = db as jest.Mocked<typeof db>;

function mockUserLookup(rows: { id: string }[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValue({ from } as never);
  return { from, where, limit };
}

function mockActivityUpsert() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  mockDb.insert.mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate };
}

describe('activityTracking.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips upsert when user id is not in auth_user', async () => {
    mockUserLookup([]);

    await recordActivity('opaque-bearer-token');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('upserts activity when user exists', async () => {
    mockUserLookup([{ id: 'user-123' }]);
    const { values, onConflictDoUpdate } = mockActivityUpsert();

    await recordActivity('user-123');

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        requestCount: 1,
      })
    );
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });
});
