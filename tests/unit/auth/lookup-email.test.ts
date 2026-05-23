import { jest } from '@jest/globals';

jest.mock('better-auth/plugins/access', () => ({
  createAccessControl: () => ({
    newRole: (statements: any) => ({
      authorize: () => ({ success: true }),
      statements,
    }),
  }),
}));

jest.mock('better-auth/plugins/organization/access', () => ({
  adminAc: { statements: {} },
  defaultStatements: {},
}));

jest.mock('@wxyc/database', () => ({
  db: {},
  user: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
}));

const mockAdapterFindOne = jest.fn();

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve({
      adapter: {
        findOne: mockAdapterFindOne,
      },
    }),
  },
  WXYCRoles: {
    member: {},
    dj: {},
    musicDirector: {},
    stationManager: {},
  },
}));

import { lookupEmailByIdentifier } from '../../../apps/auth/lookup-email';

describe('lookupEmailByIdentifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('identifier contains "@"', () => {
    it('echoes the identifier back without hitting the adapter', async () => {
      const result = await lookupEmailByIdentifier('dj@wxyc.org');

      expect(result).toBe('dj@wxyc.org');
      expect(mockAdapterFindOne).not.toHaveBeenCalled();
    });

    it('does not validate that the email belongs to a real user', async () => {
      const result = await lookupEmailByIdentifier('nobody@example.com');

      expect(result).toBe('nobody@example.com');
      expect(mockAdapterFindOne).not.toHaveBeenCalled();
    });
  });

  describe('identifier is a username', () => {
    it('returns the email for a known username', async () => {
      mockAdapterFindOne.mockResolvedValue({ email: 'jbromberg@wxyc.org' });

      const result = await lookupEmailByIdentifier('jbromberg');

      expect(result).toBe('jbromberg@wxyc.org');
      expect(mockAdapterFindOne).toHaveBeenCalledWith({
        model: 'user',
        where: [{ field: 'username', value: 'jbromberg' }],
      });
    });

    it('returns null when no user matches the username', async () => {
      mockAdapterFindOne.mockResolvedValue(null);

      const result = await lookupEmailByIdentifier('notarealdj');

      expect(result).toBeNull();
    });

    it('returns null when the user row has no email', async () => {
      mockAdapterFindOne.mockResolvedValue({ email: undefined });

      const result = await lookupEmailByIdentifier('jbromberg');

      expect(result).toBeNull();
    });
  });
});
