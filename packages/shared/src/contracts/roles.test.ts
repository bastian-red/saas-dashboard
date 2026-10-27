import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ACTIONS, can, canAssign, PERMISSIONS, ROLES, type Role } from './roles';

describe('the role matrix', () => {
  it('is monotonic: a more powerful role can do everything a weaker one can', () => {
    for (let i = 0; i < ROLES.length - 1; i += 1) {
      const stronger = ROLES[i]!;
      const weaker = ROLES[i + 1]!;
      for (const action of PERMISSIONS[weaker])
        expect(can(stronger, action), `${stronger} ${action}`).toBe(true);
    }
  });

  it('reserves deleting the workspace and changing the plan for the owner', () => {
    for (const role of ROLES) {
      expect(can(role, 'workspace.delete')).toBe(role === 'owner');
      expect(can(role, 'billing.write')).toBe(role === 'owner');
    }
  });

  it('lets a viewer read and nothing else that writes', () => {
    const writes = ACTIONS.filter((a) => !a.endsWith('.read'));
    for (const action of writes) expect(can('viewer', action), action).toBe(false);
  });
});

describe('canAssign', () => {
  const role = fc.constantFrom<Role>(...ROLES);

  it('never lets anyone hand out a role above their own', () => {
    fc.assert(
      fc.property(role, role, (actor, target) => {
        if (canAssign(actor, target))
          expect(ROLES.indexOf(target)).toBeGreaterThanOrEqual(ROLES.indexOf(actor));
      }),
    );
  });

  it('only an owner creates an owner, and a role without member.role assigns nothing', () => {
    expect(canAssign('owner', 'owner')).toBe(true);
    expect(canAssign('admin', 'owner')).toBe(false);
    expect(canAssign('admin', 'admin')).toBe(true);
    for (const target of ROLES) {
      expect(canAssign('analyst', target)).toBe(false);
      expect(canAssign('viewer', target)).toBe(false);
    }
  });
});
