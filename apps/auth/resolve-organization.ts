/**
 * Resolve an organization slug to its ID, slug, and name.
 * Used by the GET /auth/admin/resolve-organization endpoint.
 */

import { auth } from '@wxyc/authentication';

export interface ResolvedOrganization {
  id: string;
  slug: string;
  name: string;
}

/**
 * Look up an organization by slug using the better-auth adapter.
 * Returns the organization's id, slug, and name, or null if not found.
 */
export async function resolveOrganization(
  slug: string,
  _session: unknown
): Promise<ResolvedOrganization | null> {
  const context = await auth.$context;
  const { adapter } = context;

  const org = await adapter.findOne<{ id: string; slug: string; name: string }>({
    model: 'organization',
    where: [{ field: 'slug', value: slug }],
  });

  if (!org) {
    return null;
  }

  return { id: org.id, slug: org.slug, name: org.name };
}
