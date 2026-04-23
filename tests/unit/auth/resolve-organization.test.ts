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
const mockGetSession = jest.fn();

jest.mock('@wxyc/authentication', () => ({
  auth: {
    $context: Promise.resolve({
      adapter: {
        findOne: mockAdapterFindOne,
      },
    }),
    api: {
      getSession: mockGetSession,
    },
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

const ADMIN_SESSION = {
  user: { id: 'admin-1', role: 'admin', email: 'admin@wxyc.org' },
  session: { id: 'session-1' },
};

const NON_ADMIN_SESSION = {
  user: { id: 'dj-1', role: 'user', email: 'dj@wxyc.org' },
  session: { id: 'session-2' },
};

function setUpHappyPath() {
  mockGetSession.mockResolvedValue(ADMIN_SESSION);
  mockAdapterFindOne.mockResolvedValue(MOCK_ORG);
}

// --- Tests ---
describe('resolveOrganization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    beforeEach(setUpHappyPath);

    it('returns the organization id, slug, and name', async () => {
      const result = await resolveOrganization('wxyc', ADMIN_SESSION);

      expect(result).toEqual({
        id: MOCK_ORG.id,
        slug: MOCK_ORG.slug,
        name: MOCK_ORG.name,
      });
    });

    it('queries the adapter with the slug', async () => {
      await resolveOrganization('wxyc', ADMIN_SESSION);

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
      mockGetSession.mockResolvedValue(ADMIN_SESSION);
      mockAdapterFindOne.mockResolvedValue(null);

      const result = await resolveOrganization('nonexistent', ADMIN_SESSION);

      expect(result).toBeNull();
    });
  });
});
