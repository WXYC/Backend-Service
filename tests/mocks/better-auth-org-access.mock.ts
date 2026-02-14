/**
 * Minimal mock for better-auth/plugins/organization/access
 *
 * Provides the same defaultStatements and adminAc values as the real module.
 */

export const defaultStatements = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
} as const;

export const adminAc = {
  statements: {
    organization: ['update'],
    invitation: ['create', 'cancel'],
    member: ['create', 'update', 'delete'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  } as const,
};
