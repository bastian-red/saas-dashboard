/**
 * `/workspaces/:workspace/...` to a verified tenant context.
 *
 * Runs after the session guard. Resolves the slug against the signed-in user's
 * memberships through the audited `user_workspaces` function, and:
 *
 * - not a member (or no such workspace): 404, the same answer for both, so a
 *   user cannot learn which workspace slugs exist by probing them;
 * - a member whose role lacks the route's `@Requires(...)` action: 403, because
 *   they know the workspace exists and need to know why they cannot act.
 *
 * Every workspace route is behind it (the guard is global and only routes
 * without a `:workspace` parameter skip it), and every one names its action:
 * a workspace route with no `@Requires` is refused at boot by tenancy.module.ts,
 * so a new route cannot quietly default to "any member may do this".
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  can,
  DomainError,
  effectivePlan,
  planIdSchema,
  roleSchema,
  subscriptionStatusSchema,
  type Action,
  type PlanId,
  type Role,
} from '@saas/shared';

import type { RequestWithUser } from '../common/session.guard';
import { PrismaService } from '../infra/prisma.service';

export const REQUIRES = 'saas:requires';
export const Requires = (action: Action): MethodDecorator => SetMetadata(REQUIRES, action);

export interface TenantContext {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
  plan: PlanId;
  effectivePlan: PlanId;
  branding: unknown;
}

export interface RequestWithTenant extends RequestWithUser {
  tenant?: TenantContext;
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const slug = (request.params as Record<string, string | undefined>).workspace;
    if (slug === undefined) return true;
    if (request.user === undefined) throw new DomainError('UNAUTHENTICATED', 'Sign in first.');

    const rows = await this.prisma.global.userWorkspaces(request.user.id);
    const row = rows.find((r) => r.slug === slug);
    if (row === undefined) throw new DomainError('NOT_FOUND', 'No such workspace.');

    const role = roleSchema.parse(row.role);
    const plan = planIdSchema.parse(row.plan);
    request.tenant = {
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      role,
      plan,
      effectivePlan: effectivePlan(
        plan,
        row.subscription_status === null
          ? null
          : subscriptionStatusSchema.parse(row.subscription_status),
      ),
      branding: row.branding,
    };

    const action = this.reflector.get<Action | undefined>(REQUIRES, context.getHandler());
    if (action === undefined)
      throw new DomainError('FORBIDDEN', 'This route declares no permission.');
    if (!can(role, action)) throw new DomainError('FORBIDDEN', `A ${role} cannot do that here.`);
    return true;
  }
}

/** The verified tenant of this request. Throws if the guard did not run (no `:workspace`). */
export const Tenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    if (request.tenant === undefined) throw new DomainError('NOT_FOUND', 'No such workspace.');
    return request.tenant;
  },
);
