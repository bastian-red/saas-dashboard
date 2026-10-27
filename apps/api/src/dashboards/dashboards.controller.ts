import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  createDashboardSchema,
  createLaneSchema,
  reorderLanesSchema,
  updateDashboardSchema,
  updateLaneSchema,
  type Dashboard,
  type DashboardData,
  type DashboardSummary,
} from '@saas/shared';
import { z } from 'zod';

import { ZodPipe } from '../common/zod.pipe';
import { Requires, Tenant, type TenantContext } from '../tenancy/tenant.guard';
import { DashboardsService } from './dashboards.service';

const idParam = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/u);
const dataQuery = z.object({ tz: z.string().max(64).default('UTC') });

@Controller('workspaces/:workspace')
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Requires('dashboard.read')
  @Get('catalog')
  catalog(@Tenant() ctx: TenantContext) {
    return this.dashboards.catalog(ctx);
  }

  @Requires('dashboard.read')
  @Get('dashboards')
  list(@Tenant() ctx: TenantContext): Promise<DashboardSummary[]> {
    return this.dashboards.list(ctx);
  }

  @Requires('dashboard.write')
  @Post('dashboards')
  create(
    @Tenant() ctx: TenantContext,
    @Body(new ZodPipe(createDashboardSchema)) input: z.infer<typeof createDashboardSchema>,
  ): Promise<Dashboard> {
    return this.dashboards.create(ctx, input.name);
  }

  @Requires('dashboard.read')
  @Get('dashboards/:id')
  get(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<Dashboard> {
    return this.dashboards.get(ctx, id);
  }

  @Requires('dashboard.read')
  @Get('dashboards/:id/data')
  data(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Query(new ZodPipe(dataQuery)) q: z.infer<typeof dataQuery>,
  ): Promise<DashboardData> {
    return this.dashboards.data(ctx, id, q.tz);
  }

  @Requires('dashboard.write')
  @Patch('dashboards/:id')
  update(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Body(new ZodPipe(updateDashboardSchema)) input: z.infer<typeof updateDashboardSchema>,
  ): Promise<Dashboard> {
    return this.dashboards.update(ctx, id, input);
  }

  @Requires('dashboard.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('dashboards/:id')
  remove(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
  ): Promise<void> {
    return this.dashboards.remove(ctx, id);
  }

  @Requires('dashboard.write')
  @Post('dashboards/:id/lanes')
  addLane(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Body(new ZodPipe(createLaneSchema)) input: z.infer<typeof createLaneSchema>,
  ): Promise<Dashboard> {
    return this.dashboards.addLane(ctx, id, input);
  }

  @Requires('dashboard.write')
  @Put('dashboards/:id/lanes/order')
  reorder(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Body(new ZodPipe(reorderLanesSchema)) input: z.infer<typeof reorderLanesSchema>,
  ): Promise<Dashboard> {
    return this.dashboards.reorder(ctx, id, input.order);
  }

  @Requires('dashboard.write')
  @Patch('dashboards/:id/lanes/:laneId')
  updateLane(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Param('laneId', new ZodPipe(idParam)) laneId: string,
    @Body(new ZodPipe(updateLaneSchema)) input: z.infer<typeof updateLaneSchema>,
  ): Promise<Dashboard> {
    return this.dashboards.updateLane(ctx, id, laneId, input);
  }

  @Requires('dashboard.write')
  @Delete('dashboards/:id/lanes/:laneId')
  removeLane(
    @Tenant() ctx: TenantContext,
    @Param('id', new ZodPipe(idParam)) id: string,
    @Param('laneId', new ZodPipe(idParam)) laneId: string,
  ): Promise<Dashboard> {
    return this.dashboards.removeLane(ctx, id, laneId);
  }
}
