/**
 * Workspaces, members, invites and API keys.
 *
 * Every query on tenant data runs inside `prisma.tenant(ctx.tenantId, ...)`.
 * None of them filters on tenant_id: row-level security does, and a hand-written
 * filter would be a second mechanism that could disagree with the first.
 */
import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  isCheckViolation,
  isUniqueViolation,
  TENANT_SLUG_UNIQUE,
  violatedConstraint,
  violatedUniqueIndex,
} from '@saas/db';
import {
  canAssign,
  DomainError,
  PLANS,
  roleSchema,
  type ApiKey,
  type Invite,
  type Member,
  type Role,
  type SessionUser,
  type Workspace,
} from '@saas/shared';
import { z } from 'zod';

import { PrismaService, type WorkspaceRow } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import type { TenantContext } from '../tenancy/tenant.guard';
import { newSecret, sha256 } from './tokens';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const INGEST_INVALIDATE = 'ingest:invalidate';

const brandingShape = z.object({
  accent: z.string(),
  light: z.object({ accent: z.string(), ink: z.string(), soft: z.string() }),
  dark: z.object({ accent: z.string(), ink: z.string(), soft: z.string() }),
});

export function workspaceOf(
  row: Pick<WorkspaceRow, 'tenant_id' | 'slug' | 'name' | 'role' | 'plan' | 'branding'>,
): Workspace {
  const b = brandingShape.safeParse(row.branding);
  return {
    id: row.tenant_id,
    slug: row.slug,
    name: row.name,
    role: roleSchema.parse(row.role),
    plan: z.enum(['free', 'team', 'business']).parse(row.plan),
    branding: b.success ? { light: b.data.light, dark: b.data.dark } : null,
  };
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async list(user: SessionUser): Promise<Workspace[]> {
    return (await this.prisma.global.userWorkspaces(user.id)).map(workspaceOf);
  }

  async create(user: SessionUser, input: { name: string; slug: string }): Promise<Workspace> {
    // The id is chosen here, not by the database, because the tenant row itself
    // is under RLS: it can only be inserted inside its own tenant context.
    const tenantId = randomUUID();
    try {
      await this.prisma.tenant(tenantId, async (tx) => {
        await tx.tenant.create({ data: { id: tenantId, name: input.name, slug: input.slug } });
        await tx.membership.create({ data: { tenantId, userId: user.id, role: 'owner' } });
      });
    } catch (error) {
      // Not violatedUniqueIndex(error, TENANT_SLUG_UNIQUE): under row-level
      // security Postgres withholds the conflicting key from the error (the
      // caller may not see the row it collided with), so Prisma reports
      // `target: null` and no column-based check can match. In this
      // transaction the tenant id is a fresh UUID and the membership is new, so
      // a unique violation here can only be the slug.
      if (isUniqueViolation(error) || violatedUniqueIndex(error, TENANT_SLUG_UNIQUE)) {
        throw new DomainError('CONFLICT', `The address /w/${input.slug} is taken.`, {
          field: 'slug',
        });
      }
      throw error;
    }
    return {
      id: tenantId,
      slug: input.slug,
      name: input.name,
      role: 'owner',
      plan: 'free',
      branding: null,
    };
  }

  /**
   * Delete a workspace and everything in it. Raw events and rollups carry no
   * foreign key (a partitioned table referencing a hot parent is a cost every
   * insert would pay), so they are deleted explicitly in the same transaction.
   */
  async remove(ctx: TenantContext): Promise<void> {
    await this.prisma.tenant(
      ctx.tenantId,
      async (tx) => {
        for (const table of [
          'events',
          'event_hours',
          'event_dim_hours',
          'event_sum_hours',
          'aggregation_watermarks',
        ]) {
          await tx.$executeRawUnsafe(`DELETE FROM ${table}`);
        }
        await tx.tenant.delete({ where: { id: ctx.tenantId } });
      },
      { timeoutMs: 60_000 },
    );
    await this.redis.client.publish(INGEST_INVALIDATE, ctx.tenantId);
  }

  // --- members ---------------------------------------------------------------

  async members(ctx: TenantContext): Promise<Member[]> {
    const rows = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.membership.findMany({
        include: { user: { select: { email: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: roleSchema.parse(m.role),
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Change a member's role. The actor must be allowed to grant the NEW role and
   * to manage the CURRENT one, so an admin can neither promote anyone to owner
   * nor demote an owner. Demoting the last owner is refused by a trigger.
   */
  async changeRole(ctx: TenantContext, userId: string, role: Role): Promise<Member> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const current = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        include: { user: true },
      });
      if (current === null) throw new DomainError('NOT_FOUND', 'No such member.');
      if (!canAssign(ctx.role, role) || !canAssign(ctx.role, roleSchema.parse(current.role))) {
        throw new DomainError(
          'FORBIDDEN',
          `A ${ctx.role} cannot make a ${current.role} into a ${role}.`,
        );
      }
      try {
        const m = await tx.membership.update({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
          data: { role },
        });
        return {
          userId,
          email: current.user.email,
          name: current.user.name,
          role: roleSchema.parse(m.role),
          joinedAt: m.createdAt.toISOString(),
        };
      } catch (error) {
        if (isCheckViolation(error) || violatedConstraint(error, 'memberships_keep_an_owner')) {
          throw new DomainError(
            'UNPROCESSABLE',
            'A workspace must keep at least one owner. Make someone else an owner first.',
          );
        }
        throw error;
      }
    });
  }

  async removeMember(ctx: TenantContext, actor: SessionUser, userId: string): Promise<void> {
    await this.prisma.tenant(ctx.tenantId, async (tx) => {
      const current = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
      });
      if (current === null) throw new DomainError('NOT_FOUND', 'No such member.');
      // Leaving (yourself) is always allowed, subject to the last-owner rule;
      // removing someone else needs authority over their role.
      if (userId !== actor.id && !canAssign(ctx.role, roleSchema.parse(current.role))) {
        throw new DomainError('FORBIDDEN', `A ${ctx.role} cannot remove a ${current.role}.`);
      }
      try {
        await tx.membership.delete({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        });
      } catch (error) {
        if (isCheckViolation(error) || violatedConstraint(error, 'memberships_keep_an_owner')) {
          throw new DomainError('UNPROCESSABLE', 'A workspace must keep at least one owner.');
        }
        throw error;
      }
    });
  }

  // --- invites ---------------------------------------------------------------

  /**
   * An invite counts against the plan's seats while pending, so a free
   * workspace cannot hand out fifty links and let them all be accepted.
   */
  async invite(
    ctx: TenantContext,
    actor: SessionUser,
    input: { email: string; role: Role },
    now = new Date(),
  ): Promise<Invite & { token: string }> {
    if (!canAssign(ctx.role, input.role))
      throw new DomainError('FORBIDDEN', `A ${ctx.role} cannot invite a ${input.role}.`);
    const { raw, hash } = newSecret('inv_', 24);
    const seats = PLANS[ctx.effectivePlan].seats;
    const invite = await this.prisma.tenant(ctx.tenantId, async (tx) => {
      const [members, pending, existing] = await Promise.all([
        tx.membership.count(),
        tx.invite.count({ where: { acceptedAt: null, expiresAt: { gt: now } } }),
        tx.membership.findFirst({ where: { user: { email: input.email } } }),
      ]);
      if (existing !== null)
        throw new DomainError('CONFLICT', `${input.email} is already a member.`, {
          field: 'email',
        });
      if (members + pending >= seats) {
        throw new DomainError(
          'UNPROCESSABLE',
          `The ${PLANS[ctx.effectivePlan].name} plan has ${String(seats)} seats, and ${String(members + pending)} are taken or invited. Upgrade to invite more.`,
        );
      }
      return tx.invite.create({
        data: {
          tenantId: ctx.tenantId,
          email: input.email,
          role: input.role,
          tokenHash: hash,
          invitedBy: actor.id,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        },
      });
    });
    return {
      id: invite.id,
      email: invite.email,
      role: roleSchema.parse(invite.role),
      expiresAt: invite.expiresAt.toISOString(),
      token: raw,
    };
  }

  async invites(ctx: TenantContext, now = new Date()): Promise<Invite[]> {
    const rows = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.invite.findMany({
        where: { acceptedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: roleSchema.parse(i.role),
      expiresAt: i.expiresAt.toISOString(),
    }));
  }

  async revokeInvite(ctx: TenantContext, id: string): Promise<void> {
    const n = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.invite.deleteMany({ where: { id, acceptedAt: null } }),
    );
    if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such invite.');
  }

  /** Accept an invite link: the token is the only thing that names the workspace. */
  async accept(user: SessionUser, token: string, now = new Date()): Promise<Workspace> {
    const [invite] = await this.prisma.global.inviteByToken(sha256(token));
    if (invite === undefined) throw new DomainError('NOT_FOUND', 'That invite link is not valid.');
    if (invite.accepted_at !== null)
      throw new DomainError('GONE', 'That invite has already been used.');
    if (invite.expires_at.getTime() <= now.getTime())
      throw new DomainError('GONE', 'That invite has expired. Ask for a new one.');
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new DomainError(
        'FORBIDDEN',
        `This invite is for ${invite.email}. Sign in with that address to accept it.`,
      );
    }
    await this.prisma.tenant(invite.tenant_id, async (tx) => {
      const already = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: invite.tenant_id, userId: user.id } },
      });
      if (already !== null)
        throw new DomainError('CONFLICT', 'You are already a member of this workspace.');
      // Conditional: two tabs accepting at once cannot both succeed.
      const claimed = await tx.invite.updateMany({
        where: { id: invite.invite_id, acceptedAt: null },
        data: { acceptedAt: now },
      });
      if (claimed.count === 0) throw new DomainError('GONE', 'That invite has already been used.');
      await tx.membership.create({
        data: { tenantId: invite.tenant_id, userId: user.id, role: invite.role },
      });
    });
    const [row] = (await this.prisma.global.userWorkspaces(user.id)).filter(
      (w) => w.tenant_id === invite.tenant_id,
    );
    return workspaceOf(row!);
  }

  // --- API keys --------------------------------------------------------------

  async apiKeys(ctx: TenantContext): Promise<ApiKey[]> {
    const rows = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.apiKey.findMany({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    );
    return rows.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    }));
  }

  async createApiKey(ctx: TenantContext, name: string): Promise<ApiKey & { key: string }> {
    // Not `sk_live_`: that is Stripe's live-key prefix, so every customer key
    // would trip secret scanners as a Stripe credential and read as one in logs.
    const { raw, hash } = newSecret('sk_saas_', 24);
    const k = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.apiKey.create({
        data: { tenantId: ctx.tenantId, name, prefix: raw.slice(0, 12), keyHash: hash },
      }),
    );
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: null,
      key: raw,
    };
  }

  /** Revoked at once: the ingest service's key cache is evicted, not left to expire. */
  async revokeApiKey(ctx: TenantContext, id: string): Promise<void> {
    const n = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such key.');
    await this.redis.client.publish(INGEST_INVALIDATE, ctx.tenantId);
  }
}
