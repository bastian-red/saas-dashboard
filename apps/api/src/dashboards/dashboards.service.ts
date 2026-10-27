/**
 * Dashboards, their lanes, and the data behind them.
 */
import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@saas/db';
import {
  compileBuckets,
  compileLane,
  shapeSketches,
  shapeValues,
  type SketchRow,
  type ValueRow,
} from '@saas/query-engine';
import {
  DomainError,
  laneSpecSchema,
  rangeSchema,
  type Dashboard,
  type DashboardData,
  type DashboardSummary,
  type Lane,
  type LaneSpec,
  type RangeKey,
} from '@saas/shared';

import { PrismaService } from '../infra/prisma.service';
import type { TenantContext } from '../tenancy/tenant.guard';
import { isTimeZone, windowFor } from './window';

export const MAX_LANES = 12;

type LaneRow = {
  id: string;
  title: string | null;
  position: number;
  height: number;
  spec: unknown;
};

function toLane(r: LaneRow): Lane {
  return {
    id: r.id,
    title: r.title,
    position: r.position,
    height: r.height,
    spec: laneSpecSchema.parse(r.spec),
  };
}

@Injectable()
export class DashboardsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext): Promise<DashboardSummary[]> {
    const rows = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.dashboard.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { _count: { select: { lanes: true } } },
      }),
    );
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      lanes: d._count.lanes,
      updatedAt: d.updatedAt.toISOString(),
    }));
  }

  async create(ctx: TenantContext, name: string): Promise<Dashboard> {
    const d = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.dashboard.create({ data: { tenantId: ctx.tenantId, name } }),
    );
    return {
      id: d.id,
      name: d.name,
      range: rangeSchema.parse(d.range),
      lanes: [],
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async get(ctx: TenantContext, id: string): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, (tx) => this.load(tx, id));
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: { name?: string; range?: RangeKey },
  ): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const n = await tx.dashboard.updateMany({ where: { id }, data: input });
      if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such dashboard.');
      return this.load(tx, id);
    });
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const n = await this.prisma.tenant(ctx.tenantId, (tx) =>
      tx.dashboard.deleteMany({ where: { id } }),
    );
    if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such dashboard.');
  }

  async addLane(
    ctx: TenantContext,
    dashboardId: string,
    input: { title: string | null; spec: LaneSpec; height: number },
  ): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const d = await this.load(tx, dashboardId);
      if (d.lanes.length >= MAX_LANES)
        throw new DomainError(
          'UNPROCESSABLE',
          `A dashboard holds at most ${String(MAX_LANES)} lanes.`,
        );
      // tenantId comes from the context, and the composite foreign key
      // (dashboard_id, tenant_id) means a lane cannot point at another
      // workspace's dashboard even if this line were wrong.
      await tx.lane.create({
        data: {
          tenantId: ctx.tenantId,
          dashboardId,
          title: input.title,
          spec: input.spec,
          height: input.height,
          position: d.lanes.length,
        },
      });
      await tx.dashboard.update({ where: { id: dashboardId }, data: { updatedAt: new Date() } });
      return this.load(tx, dashboardId);
    });
  }

  async updateLane(
    ctx: TenantContext,
    dashboardId: string,
    laneId: string,
    input: { title?: string | null; spec?: LaneSpec; height?: number },
  ): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const n = await tx.lane.updateMany({ where: { id: laneId, dashboardId }, data: input });
      if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such lane.');
      await tx.dashboard.update({ where: { id: dashboardId }, data: { updatedAt: new Date() } });
      return this.load(tx, dashboardId);
    });
  }

  async removeLane(ctx: TenantContext, dashboardId: string, laneId: string): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const n = await tx.lane.deleteMany({ where: { id: laneId, dashboardId } });
      if (n.count === 0) throw new DomainError('NOT_FOUND', 'No such lane.');
      // Re-pack positions 0..n-1; the unique constraint is deferred to commit.
      const rest = await tx.lane.findMany({ where: { dashboardId }, orderBy: { position: 'asc' } });
      for (const [i, l] of rest.entries())
        if (l.position !== i) await tx.lane.update({ where: { id: l.id }, data: { position: i } });
      return this.load(tx, dashboardId);
    });
  }

  /** `order` must be exactly the dashboard's lane ids, each once. */
  async reorder(ctx: TenantContext, dashboardId: string, order: string[]): Promise<Dashboard> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const d = await this.load(tx, dashboardId);
      const current = new Set(d.lanes.map((l) => l.id));
      if (
        order.length !== current.size ||
        new Set(order).size !== order.length ||
        !order.every((id) => current.has(id))
      ) {
        throw new DomainError(
          'INVALID',
          'The new order must list every lane of this dashboard exactly once.',
        );
      }
      for (const [i, id] of order.entries())
        await tx.lane.update({ where: { id }, data: { position: i } });
      return this.load(tx, dashboardId);
    });
  }

  /**
   * Every lane's numbers on the dashboard's shared axis. One transaction, so all
   * lanes read the same snapshot of the rollups (the crosshair compares lanes at
   * one instant, and they must agree on what that instant contained).
   */
  async data(ctx: TenantContext, id: string, tz: string, now = new Date()): Promise<DashboardData> {
    if (!isTimeZone(tz))
      throw new DomainError('INVALID', `"${tz}" is not a time zone.`, { field: 'tz' });
    return this.prisma.tenant(
      ctx.tenantId,
      async (tx) => {
        const d = await this.load(tx, id);
        const w = windowFor(d.range, tz, now);
        const b = compileBuckets(w);
        const buckets = (await tx.$queryRawUnsafe<{ bucket: Date }[]>(b.sql, ...b.params)).map(
          (r) => r.bucket,
        );
        const lanes = [];
        for (const lane of d.lanes) {
          const c = compileLane(lane.spec, w);
          if (c.shape === 'sketches') {
            const rows = await tx.$queryRawUnsafe<{ bucket: Date; sketch: Uint8Array }[]>(
              c.sql,
              ...c.params,
            );
            lanes.push(
              shapeSketches(
                lane.id,
                buckets,
                rows.map((r): SketchRow => ({ bucket: r.bucket, sketch: r.sketch })),
              ),
            );
          } else {
            const rows = await tx.$queryRawUnsafe<{ bucket: Date; key: string; value: number }[]>(
              c.sql,
              ...c.params,
            );
            lanes.push(
              shapeValues(
                lane.id,
                buckets,
                rows.map((r): ValueRow => ({
                  bucket: r.bucket,
                  key: r.key,
                  value: Number(r.value),
                })),
              ),
            );
          }
        }
        return {
          from: w.from.toISOString(),
          to: w.to.toISOString(),
          bucket: w.bucket,
          tz,
          buckets: buckets.map((x) => x.toISOString()),
          lanes,
        };
      },
      { timeoutMs: 20_000 },
    );
  }

  /**
   * What can be asked about: the events this workspace has sent and their
   * properties (breakdown-able strings and summable numbers), from the rollups
   * of the last 90 days. Feeds the sentence editor's pickers.
   */
  async catalog(ctx: TenantContext): Promise<{
    events: { name: string; count: number }[];
    properties: { event: string; property: string; kind: 'string' | 'number' }[];
  }> {
    return this.prisma.tenant(ctx.tenantId, async (tx) => {
      const events = await tx.$queryRaw<{ name: string; count: bigint }[]>`
        SELECT event AS name, sum(count) AS count FROM event_hours WHERE hour > now() - INTERVAL '90 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 200`;
      const props = await tx.$queryRaw<
        { event: string; property: string; kind: 'string' | 'number' }[]
      >`
        SELECT DISTINCT event, property, 'string' AS kind FROM event_dim_hours WHERE hour > now() - INTERVAL '90 days'
        UNION SELECT DISTINCT event, property, 'number' AS kind FROM event_sum_hours WHERE hour > now() - INTERVAL '90 days'
        ORDER BY 1, 2 LIMIT 2000`;
      return {
        events: events.map((e) => ({ name: e.name, count: Number(e.count) })),
        properties: props,
      };
    });
  }

  private async load(tx: TenantTx, id: string): Promise<Dashboard> {
    const d = await tx.dashboard.findUnique({
      where: { id },
      include: { lanes: { orderBy: { position: 'asc' } } },
    });
    if (d === null) throw new DomainError('NOT_FOUND', 'No such dashboard.');
    return {
      id: d.id,
      name: d.name,
      range: rangeSchema.parse(d.range),
      lanes: d.lanes.map(toLane),
      updatedAt: d.updatedAt.toISOString(),
    };
  }
}
