/**
 * Minimal mock for @wxyc/authentication workspace package.
 * Tests that need auth should provide their own jest.mock() factory.
 */
export const auth = {
  api: {
    getSession: async () => null,
  },
};

export const requirePermissions = () => (_req: unknown, _res: unknown, next: () => void) => next();
