/**
 * Role resolution for the two token-minting paths.
 *
 * Both answer the same question — "what is this user's WXYC station role?" —
 * and both must answer it from `auth_member.role`. `auth_user.role` is the
 * better-auth admin plugin's own system flag ('user' | 'admin' | NULL) and
 * carries no station role; reading a station role off it is the defect
 * tracked in BS#2171.
 *
 * Extracted from the `betterAuth({...})` literal so the policy is
 * unit-testable: the literal's properties are unreachable from a test, and
 * `jest.unit.config.ts` maps `@wxyc/authentication` to a mock. DB access
 * arrives as a callback for the same reason — a value import from
 * `@wxyc/database` would re-engage the DB mock and defeat the injection.
 * Same shape as `device-authorization.ts`.
 */

/** A single `auth_member` row's role, or `undefined` when the user has no membership. */
export type MemberRoleRow = { role: string } | undefined;

export type FetchMemberRole = (userId: string) => Promise<MemberRoleRow>;

type WithCapabilities = { capabilities?: string[] | null };

/**
 * Build the JWT payload for a user, resolving `role` from organization
 * membership.
 *
 * A membership row supplies `role`. Absent membership — or a failed lookup —
 * falls through to the caller's own fields.
 */
export async function buildJwtPayload<TUser extends { id?: string }>(
  user: TUser,
  fetchMemberRole: FetchMemberRole,
  onError: (error: unknown) => void
): Promise<TUser & { role?: string; capabilities: string[] }> {
  const capabilities = (user as TUser & WithCapabilities)?.capabilities ?? [];

  if (user?.id) {
    try {
      const memberRow = await fetchMemberRole(user.id);
      if (memberRow) {
        return { ...user, role: memberRow.role, capabilities };
      }
    } catch (error) {
      onError(error);
    }
  }

  // No organization membership, or the query failed.
  return { ...user, capabilities };
}

/**
 * Build the `id_token` additional-info claim for the OIDC provider.
 *
 * Degrades to `'member'` — the least-privileged station role — on both an
 * absent membership and a thrown lookup, so a transient DB failure cannot
 * mint a token claiming more authority than the user holds.
 */
export async function buildOidcUserInfoClaim(
  userRecord: { id: string },
  fetchMemberRole: FetchMemberRole
): Promise<{ role: string; capabilities: string[] }> {
  try {
    const memberRow = await fetchMemberRole(userRecord.id);
    return {
      role: memberRow?.role ?? 'member',
      capabilities: (userRecord as typeof userRecord & WithCapabilities).capabilities ?? [],
    };
  } catch {
    return { role: 'member', capabilities: [] };
  }
}
