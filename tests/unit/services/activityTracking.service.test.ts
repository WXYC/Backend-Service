jest.mock('@wxyc/database', () => ({
  db: {
    insert: jest.fn(),
  },
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

  it('upserts without a user existence pre-check', async () => {
    const { values, onConflictDoUpdate } = mockActivityUpsert();

    await recordActivity('opaque-bearer-token');

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'opaque-bearer-token',
        requestCount: 1,
      })
    );
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });

  it('upserts activity for a known user id', async () => {
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
