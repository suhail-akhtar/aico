/**
 * Roles and permissions (ADR 0040). The whole table is code, on purpose: an
 * authorisation rule that lives in a database row can be edited by whoever
 * can write the row; this one changes only with a release, and the test walks
 * every role against every permission.
 *
 * Deliberately not here: custom roles (phase 3). An unknown role has no
 * permission at all — a typo or a downgrade can only lose access.
 *
 * `teamScoped` roles see only their own team's users, devices and usage; the
 * repository applies the filter, `can()` only says the permission exists.
 *
 * @module rbac
 */

export const PERMISSIONS = [
  'tenant.read', 'tenant.manage', 'users.read', 'users.manage', 'teams.read', 'teams.manage', 'roles.read',
  'policies.read', 'policies.manage', 'devices.read', 'devices.revoke', 'audit.read', 'audit.export',
  'usage.read', 'budgets.manage', 'engine.use',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'admin', 'auditor', 'team-lead', 'developer', 'contractor'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleDef { id: Role; label: string; description: string; permissions: readonly Permission[]; teamScoped: boolean }

const ALL = PERMISSIONS;
const READ_ALL: Permission[] = ['tenant.read', 'users.read', 'teams.read', 'roles.read', 'policies.read', 'devices.read', 'audit.read', 'usage.read'];

export const ROLE_DEFS: Readonly<Record<Role, RoleDef>> = {
  owner: { id: 'owner', label: 'Owner', description: 'Everything, including the identity provider and who else is an owner.', permissions: ALL, teamScoped: false },
  admin: { id: 'admin', label: 'Admin', description: 'Users, teams, policies, devices, budgets and audit. Cannot change the identity provider or owners.', permissions: ALL.filter(p => p !== 'tenant.manage'), teamScoped: false },
  auditor: { id: 'auditor', label: 'Auditor', description: 'Reads everything, exports the audit trail, changes nothing.', permissions: [...READ_ALL, 'audit.export', 'engine.use'], teamScoped: false },
  'team-lead': { id: 'team-lead', label: 'Team lead', description: 'Sees the people, devices and usage of their own team.', permissions: ['users.read', 'teams.read', 'roles.read', 'devices.read', 'usage.read', 'engine.use'], teamScoped: true },
  developer: { id: 'developer', label: 'Developer', description: 'Uses AICO under the organisation policy.', permissions: ['engine.use'], teamScoped: false },
  contractor: { id: 'contractor', label: 'Contractor', description: 'Uses AICO; normally under a tighter role policy.', permissions: ['engine.use'], teamScoped: false },
};

export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);

export function permissionsOf(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_DEFS[role].permissions : [];
}

export function can(role: string, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}

export const isTeamScoped = (role: string): boolean => isRole(role) && ROLE_DEFS[role].teamScoped;

/** Whether anyone with this role may open the admin portal at all. */
export const hasPortalAccess = (role: string): boolean => permissionsOf(role).some(p => p !== 'engine.use');

/** May `actor` give or take away `target` (a role)? Only an owner touches owners. */
export function canAssign(actorRole: string, target: string): boolean {
  if (!can(actorRole, 'users.manage') || !isRole(target)) return false;
  return target !== 'owner' || actorRole === 'owner';
}
