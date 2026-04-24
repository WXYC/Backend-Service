import { jest } from '@jest/globals';

// --- Mocks ---

// Mock better-auth modules (ESM-only)
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

// Mock @wxyc/database (not used by this endpoint, but required by @wxyc/authentication)
jest.mock('@wxyc/database', () => ({
  db: {},
  user: { id: 'id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
}));

// Mock auth context
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

// --- Import after mocks ---
import { resolveOrganization } from '../../../apps/auth/resolve-organization';

// --- Helpers ---
const MOCK_ORG = {
  id: 'org-uuid-123',
  slug: 'wxyc',
  name: 'WXYC 89.3 FM',
};

// --- Tests ---
describe('resolveOrganization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    beforeEach(() => {
      mockAdapterFindOne.mockResolvedValue(MOCK_ORG);
    });

    it('returns the organization id, slug, and name', async () => {
      const result = await resolveOrganization('wxyc');

      expect(result).toEqual({
        id: MOCK_ORG.id,
        slug: MOCK_ORG.slug,
        name: MOCK_ORG.name,
      });
    });

    it('queries the adapter with the slug', async () => {
      await resolveOrganization('wxyc');

      expect(mockAdapterFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'organization',
          where: [{ field: 'slug', value: 'wxyc' }],
        })
      );
    });
  });

  describe('organization not found', () => {
    it('returns null when the slug does not match any organization', async () => {
      mockAdapterFindOne.mockResolvedValue(null);

      const result = await resolveOrganization('nonexistent');

      expect(result).toBeNull();
    });
  });
});
