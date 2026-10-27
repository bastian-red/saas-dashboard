import { z } from 'zod';

/**
 * Roles and what each may do, as DATA.
 *
 * One table read by the API guard, the web app (to hide what a role cannot use)
 * and the integration suite (which walks every role x action pair against the
 * real API). A permission granted in one place and forgotten in another is the
 * classic multi-tenant bug; with one table there is no second place.
 *
 * Ordered by power. `owner` exists once per workspace and is the only role that
 * may delete it or change the plan; `admin` runs the team and the settings;
 * `analyst` builds dashboards; `viewer` reads.
 */
export const ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const ACTIONS = [
  'dashboard.read',
  'dashboard.write',
  'apikey.read',
  'apikey.write',
  'member.read',
  'member.invite',
  'member.role',
  'member.remove',
  'branding.write',
  'billing.read',
  'billing.write',
  'workspace.delete',
] as const;
export const actionSchema = z.enum(ACTIONS);
export type Action = z.infer<typeof actionSchema>;

const ALL: readonly Action[] = ACTIONS;

export const PERMISSIONS: Readonly<Record<Role, ReadonlySet<Action>>> = Object.freeze({
  owner: new Set(ALL),
  admin: new Set<Action>([
    'dashboard.read',
    'dashboard.write',
    'apikey.read',
    'apikey.write',
    'member.read',
    'member.invite',
    'member.role',
    'member.remove',
    'branding.write',
    'billing.read',
  ]),
  analyst: new Set<Action>(['dashboard.read', 'dashboard.write', 'apikey.read', 'member.read']),
  viewer: new Set<Action>(['dashboard.read', 'member.read']),
});

export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[role].has(action);
}

/**
 * Who may assign which role. Nobody hands out a role above their own, and only
 * an owner creates another owner (ownership transfer), so an admin cannot
 * promote themselves past the person who can delete the workspace.
 */
export function canAssign(actor: Role, target: Role): boolean {
  if (!can(actor, 'member.role')) return false;
  if (target === 'owner') return actor === 'owner';
  return ROLES.indexOf(target) >= ROLES.indexOf(actor);
}
