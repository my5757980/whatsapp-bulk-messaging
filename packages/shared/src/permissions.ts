// Role -> permission matrix from the spec.md role table (User Story 6), used by both the API
// guard (enforcement) and the web app (hiding actions). Single source of truth (research R18).
import { Role } from './enums.js';

export const ALL_PERMISSIONS = [
  'users.manage',
  'settings.view',
  'settings.manage',
  'numbers.view',
  'numbers.manage',
  'contacts.view',
  'contacts.manage',
  'contacts.delete',
  'attributes.manage',
  'templates.view',
  'templates.manage',
  'campaigns.view',
  'campaigns.manage',
  'campaigns.launch',
  'data.export',
  'phones.full',
  'apikeys.manage',
  'ratecard.manage',
  'audit.view',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

const MANAGER_PERMISSIONS: readonly Permission[] = [
  'settings.view',
  'numbers.view',
  'contacts.view',
  'contacts.manage',
  'attributes.manage',
  'templates.view',
  'templates.manage',
  'campaigns.view',
  'campaigns.manage',
  'campaigns.launch',
  'data.export',
  'phones.full',
];

const AGENT_PERMISSIONS: readonly Permission[] = ['contacts.view', 'templates.view', 'campaigns.view'];

const MATRIX: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  [Role.ADMIN]: new Set<Permission>(ALL_PERMISSIONS),
  [Role.MANAGER]: new Set<Permission>(MANAGER_PERMISSIONS),
  [Role.AGENT]: new Set<Permission>(AGENT_PERMISSIONS),
};

/** True when the role grants the permission. Unknown roles get nothing. */
export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role]?.has(permission) ?? false;
}

/** All permissions of a role (e.g. for GET /auth/me). */
export function permissionsFor(role: Role): Permission[] {
  return [...(MATRIX[role] ?? [])];
}

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
