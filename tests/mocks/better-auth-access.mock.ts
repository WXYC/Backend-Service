/**
 * Minimal mock for better-auth/plugins/access
 *
 * Provides createAccessControl and newRole that mimic the real behavior
 * closely enough to validate role permission definitions.
 */

type Statement = Record<string, readonly string[]>;

/**
 * Per-resource request shape. Real better-auth accepts either a bare action
 * list or `{ actions, connector }`, and the two are NOT interchangeable — a
 * per-resource `connector: 'OR'` turns `every` into `some`. An earlier version
 * of this mock understood only the array form and threw
 * `TypeError: actions is not iterable` on the object one.
 */
type ActionRequest = readonly string[] | { actions?: readonly string[]; connector?: string };

type NormalizedActionRequest = { actions: readonly string[]; connector: string };

/** Mirrors better-auth's `normalizeConnector`: anything but the literal `'OR'` is `'AND'`. */
const normalizeConnector = (connector: string | undefined): string => (connector === 'OR' ? 'OR' : 'AND');

/** Mirrors better-auth's `normalizeActionRequest`, including its throw on a non-object. */
const normalizeActionRequest = (requested: unknown): NormalizedActionRequest => {
  if (Array.isArray(requested)) return { actions: requested as readonly string[], connector: 'AND' };
  if (!requested || typeof requested !== 'object') throw new Error('Invalid access control request');
  const { actions, connector } = requested as { actions?: unknown; connector?: string };
  if (!Array.isArray(actions)) return { actions: [], connector: normalizeConnector(connector) };
  return { actions: actions as readonly string[], connector: normalizeConnector(connector) };
};

/** Mirrors better-auth's `isResourceAuthorized`. An empty action list authorizes nothing. */
const isResourceAuthorized = (allowed: readonly string[], { actions, connector }: NormalizedActionRequest): boolean => {
  if (actions.length === 0) return false;
  const permits = (action: string) => typeof action === 'string' && allowed.includes(action);
  return connector === 'OR' ? actions.some(permits) : actions.every(permits);
};

export function createAccessControl<S extends Statement>(_statements: S) {
  return {
    newRole(permissions: Partial<{ [K in keyof S]: readonly string[] }>) {
      return {
        /**
         * Structurally mirrors better-auth's own `role().authorize` so the
         * `success` verdict agrees on every request shape, not just the one
         * `requirePermissions` happens to send today. Only `success` is
         * modelled — the real implementation also returns distinct `error`
         * strings, which `access-mock-parity.ts` deliberately does not compare.
         *
         * Three shapes this must get right, each of which a simpler mock got
         * wrong: an empty request and an empty action list authorize nothing
         * (`[]` is how `auth.roles.ts` spells an explicit denial — see
         * `stripEmpty`); the per-resource object form carries its own
         * connector; and the top-level `connector` decides whether an
         * unknown or unauthorized resource is fatal or merely skipped.
         *
         * Note the top-level connector is compared by identity, NOT run
         * through `normalizeConnector` — that asymmetry is better-auth's, and
         * it makes an unrecognized value a third behaviour rather than an
         * alias for `'AND'`. Copied deliberately.
         */
        authorize(request: Partial<{ [K in keyof S]: ActionRequest }>, connector: string = 'AND') {
          let hasAuthorizedResource = false;
          for (const [resource, requestedActions] of Object.entries(request)) {
            const allowed = permissions[resource as keyof S] as readonly string[] | undefined;
            if (!allowed) {
              if (connector === 'AND') return { success: false };
              continue;
            }
            const isAuthorized = isResourceAuthorized(allowed, normalizeActionRequest(requestedActions));
            if (isAuthorized) hasAuthorizedResource = true;
            if (isAuthorized && connector === 'OR') return { success: true };
            if (!isAuthorized && connector === 'AND') return { success: false };
          }
          return { success: hasAuthorizedResource };
        },
        statements: permissions,
      };
    },
  };
}
