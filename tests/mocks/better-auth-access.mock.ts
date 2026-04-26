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
          for (const [resource, actions] of Object.entries(request)) {
            if (!actions || (actions as string[]).length === 0) continue;
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
