import { APIError } from 'better-auth/api';
import { CAPABILITIES, canAssignCapability, canonicalizeRole, type Capability } from '@wxyc/shared/auth-client/auth';

/**
 * The better-auth admin plugin routes that can write `auth_user.capabilities`,
 * both through the request's `data` object (the field is `input: false`, which
 * the plugin does not enforce on admin `data`).
 */
export const CAPABILITY_WRITE_PATHS = ['/admin/update-user', '/admin/create-user'] as const;

export interface CapabilityAssignDeps {
  selectMemberRole: (userId: string) => Promise<{ role: string } | undefined>;
  readCapabilities: (userId: string) => Promise<string[]>;
}

const isCapability = (name: string): name is Capability => (CAPABILITIES as readonly string[]).includes(name);

/**
 * Refuse (403) a capabilities write whose added or removed capabilities the
 * caller may not assign, using `canAssignCapability` from `@wxyc/shared` (the
 * station-manager-only rule). The single check for every route in
 * `CAPABILITY_WRITE_PATHS`; a capability the policy does not know is refused unless
 * the caller is a station manager. A request that does not touch `data.capabilities`, passes through; one
 * with `data.capabilities` and no resolved session is refused (401). Exported as a pure
 * function over injected reads so it is unit-testable without better-auth.
 */
export async function assertCanAssignCapabilities(
  path: string,
  body: unknown,
  actor: { id: string; capabilities: string[] | null | undefined } | null,
  deps: CapabilityAssignDeps
): Promise<void> {
  if (!(CAPABILITY_WRITE_PATHS as readonly string[]).includes(path)) {
    return;
  }
  const { userId, data } = (body ?? {}) as { userId?: unknown; data?: { capabilities?: unknown } | null };
  const requested = data?.capabilities;
  if (requested === undefined) {
    return;
  }
  if (!Array.isArray(requested) || !requested.every((name) => typeof name === 'string')) {
    throw new APIError('BAD_REQUEST', {
      code: 'CAPABILITIES_MUST_BE_STRING_ARRAY',
      message: '`data.capabilities` must be an array of strings.',
    });
  }
  // Fail closed: the plugin coerces `userId` (z.coerce.string()) after this hook sees the raw body, so
  // an array or number here would otherwise skip the check and still write.
  if (path === '/admin/update-user' && (typeof userId !== 'string' || userId.length === 0)) {
    throw new APIError('BAD_REQUEST', {
      code: 'USER_ID_MUST_BE_STRING',
      message: '`userId` must be a non-empty string when `data.capabilities` is set.',
    });
  }
  // Fail closed: no resolved session means we cannot say who is assigning, so refuse rather than leave it
  // to the admin plugin, which may resolve a session this caller's headers did not give us.
  if (!actor) {
    throw new APIError('UNAUTHORIZED', {
      code: 'SESSION_REQUIRED',
      message: 'A session is required to set capabilities.',
    });
  }

  let current: string[] = [];
  if (path === '/admin/update-user' && typeof userId === 'string') {
    current = await deps.readCapabilities(userId);
  }
  const changed = [
    ...requested.filter((name: string) => !current.includes(name)),
    ...current.filter((name) => !requested.includes(name)),
  ];
  if (changed.length === 0) {
    return;
  }

  const role = canonicalizeRole((await deps.selectMemberRole(actor.id))?.role);
  const held = (actor.capabilities ?? []).filter(isCapability);
  // A name outside the shared policy (e.g. the operator-granted `crm_merge`) has no assigner rule, and
  // `canAssignCapability` would throw on it; only a station manager may touch one.
  const canAssign = (name: string): boolean =>
    isCapability(name) ? canAssignCapability({ role, capabilities: held }, name) : role === 'stationManager';
  const refused = changed.filter((name) => !canAssign(name));
  if (refused.length > 0) {
    throw new APIError('FORBIDDEN', {
      code: 'CAPABILITY_ASSIGNMENT_FORBIDDEN',
      message: `You may not assign or remove these capabilities: ${refused.join(', ')}.`,
    });
  }
}
