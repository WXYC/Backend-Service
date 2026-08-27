/**
 * Minimal mock for better-auth/plugins/access
 *
 * Provides createAccessControl and newRole that mimic the real behavior
 * closely enough to validate role permission definitions.
 */

type Statement = Record<string, readonly string[]>;

export function createAccessControl<S extends Statement>(_statements: S) {
  return {
    newRole(permissions: Partial<{ [K in keyof S]: readonly string[] }>) {
      return {
        authorize(request: Partial<{ [K in keyof S]: string[] }>) {
          // An empty request authorizes nothing, and neither does an empty
          // action list — matching real better-auth, whose `isResourceAuthorized`
          // returns false on `actions.length === 0` and whose top-level check
          // rejects a request with no resources at all. The previous `continue`
          // fell through to `success: true` for both, a divergence the parity
          // comparator missed because it never sent either shape. It matters
          // here specifically: `[]` is how auth.roles.ts spells an explicit
          // denial (see `stripEmpty`).
          const entries = Object.entries(request);
          if (entries.length === 0) return { success: false };
          for (const [resource, actions] of entries) {
            if (!actions || (actions as string[]).length === 0) return { success: false };
            const allowed = permissions[resource as keyof S];
            if (!allowed) return { success: false };
            for (const action of actions as string[]) {
              if (!(allowed as readonly string[]).includes(action)) {
                return { success: false };
              }
            }
          }
          return { success: true };
        },
        statements: permissions,
      };
    },
  };
}
