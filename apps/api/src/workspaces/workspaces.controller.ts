import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  changeRoleSchema,
  createApiKeySchema,
  createInviteSchema,
  createWorkspaceSchema,
  DomainError,
  type ApiKey,
  type Invite,
  type Member,
  type SessionUser,
  type Workspace,
} from '@saas/shared';
import { z } from 'zod';

import { CurrentUser } from '../common/session.guard';
import { Budget } from '../common/throttle';
import { ZodPipe } from '../common/zod.pipe';
import { API_CONFIG, type ApiConfig } from '../config/config';
import { Requires, Tenant, type TenantContext } from '../tenancy/tenant.guard';
import { workspaceOf, WorkspacesService } from './workspaces.service';

const idParam = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);
const acceptSchema = z.object({ token: z.string().min(10).max(200) }).strict();

/**
 * The hosted demo's shared read-only login stays in its workspace: one visitor
 * leaving would hand every later visitor an empty account. Locally the list is
 * empty and every member may leave. Checked against the verified session's
 * email, so no request field can opt out.
 */
export function assertMayLeave(user: Pick<SessionUser, 'email'>, pinned: readonly string[]): void {
  if (pinned.includes(user.email.toLowerCase())) {
    throw new DomainError(
      'FORBIDDEN',
      'This is the shared demo login, so it stays in this workspace for the next visitor. ' +
        'Create your own account to try leaving a workspace.',
    );
  }
}

/** Routes with no workspace yet: the switcher, creating one, accepting an invite. */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<Workspace[]> {
    return this.workspaces.list(user);
  }

  @Post()
  create(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createWorkspaceSchema)) input: z.infer<typeof createWorkspaceSchema>,
  ): Promise<Workspace> {
    return this.workspaces.create(user, input);
  }

  @HttpCode(HttpStatus.OK)
  @Post('invites/accept')
  accept(
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(acceptSchema)) input: z.infer<typeof acceptSchema>,
  ): Promise<Workspace> {
    return this.workspaces.accept(user, input.token);
  }
}

@Controller('workspaces/:workspace')
export class WorkspaceController {
  constructor(
    private readonly workspaces: WorkspacesService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Requires('dashboard.read')
  @Get()
  get(@Tenant() ctx: TenantContext): Workspace {
    return workspaceOf({
      tenant_id: ctx.tenantId,
      slug: ctx.slug,
      name: ctx.name,
      role: ctx.role,
      plan: ctx.plan,
      branding: ctx.branding,
    });
  }

  @Requires('workspace.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete()
  remove(@Tenant() ctx: TenantContext): Promise<void> {
    return this.workspaces.remove(ctx);
  }

  @Requires('member.read')
  @Get('members')
  members(@Tenant() ctx: TenantContext): Promise<Member[]> {
    return this.workspaces.members(ctx);
  }

  @Requires('member.role')
  @Patch('members/:userId')
  changeRole(
    @Tenant() ctx: TenantContext,
    @Param('userId', new ZodPipe(idParam)) userId: string,
    @Body(new ZodPipe(changeRoleSchema)) input: z.infer<typeof changeRoleSchema>,
  ): Promise<Member> {
    return this.workspaces.changeRole(ctx, userId, input.role);
  }

  @Requires('member.remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('members/:userId')
  removeMember(
    @Tenant() ctx: TenantContext,
    @CurrentUser() user: SessionUser,
    @Param('userId', new ZodPipe(idParam)) userId: string,
  ): Promise<void> {
    return this.workspaces.removeMember(ctx, user, userId);
  }

  /** Leave the workspace. Every member may; the last owner may not (trigger). */
  @Requires('member.read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('membership')
  leave(@Tenant() ctx: TenantContext, @CurrentUser() user: SessionUser): Promise<void> {
    assertMayLeave(user, this.config.demoPinnedUsers);
    return this.workspaces.removeMember(ctx, user, user.id);
  }

  @Requires('member.invite')
  @Get('invites')
  invites(@Tenant() ctx: TenantContext): Promise<Invite[]> {
    return this.workspaces.invites(ctx);
  }

  @Requires('member.invite')
  @Budget('invite')
  @Post('invites')
  invite(
    @Tenant() ctx: TenantContext,
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(createInviteSchema)) input: z.infer<typeof createInviteSchema>,
  ): Promise<Invite & { token: string }> {
    return this.workspaces.invite(ctx, user, input);
  }

  @Requires('member.invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('invites/:id')
  revokeInvite(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<void> {
    return this.workspaces.revokeInvite(ctx, id);
  }

  @Requires('apikey.read')
  @Get('api-keys')
  apiKeys(@Tenant() ctx: TenantContext): Promise<ApiKey[]> {
    return this.workspaces.apiKeys(ctx);
  }

  @Requires('apikey.write')
  @Post('api-keys')
  createApiKey(
    @Tenant() ctx: TenantContext,
    @Body(new ZodPipe(createApiKeySchema)) input: z.infer<typeof createApiKeySchema>,
  ): Promise<ApiKey & { key: string }> {
    return this.workspaces.createApiKey(ctx, input.name);
  }

  @Requires('apikey.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('api-keys/:id')
  revokeApiKey(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<void> {
    return this.workspaces.revokeApiKey(ctx, id);
  }
}
