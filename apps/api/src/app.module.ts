/**
 * The application graph.
 *
 * Three global guards, in order, each failing closed:
 *
 * 1. `SessionGuard`: every route needs a service token unless `@Public()`.
 * 2. `TenantGuard`: every route with a `:workspace` parameter resolves the
 *    caller's membership (404 if none) and checks the route's `@Requires`
 *    action against the role matrix (403 if not allowed). `RouteAudit` refuses
 *    to boot if a workspace route declares no action.
 * 3. `ThrottlerGuard`: the general budget everywhere; `auth` and `invite` add
 *    stricter ones where `@Budget` asks; health, status and the webhook skip.
 */
import { APP_FILTER, APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { API_CONFIG, type ApiConfig } from './config/config';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { BillingController, WorkspaceBillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { SessionGuard } from './common/session.guard';
import { throttlers } from './common/throttle';
import { DashboardsController } from './dashboards/dashboards.controller';
import { DashboardsService } from './dashboards/dashboards.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { StatusController } from './status/status.controller';
import { RouteAudit } from './tenancy/route-audit';
import { TenantGuard } from './tenancy/tenant.guard';
import { WorkspaceController, WorkspacesController } from './workspaces/workspaces.controller';
import { WorkspacesService } from './workspaces/workspaces.service';

@Module({
  imports: [
    InfraModule,
    DiscoveryModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: throttlers(config),
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [
    AuthController,
    WorkspacesController,
    WorkspaceController,
    DashboardsController,
    WorkspaceBillingController,
    BillingController,
    HealthController,
    StatusController,
  ],
  providers: [
    AuthService,
    WorkspacesService,
    DashboardsService,
    BillingService,
    HealthService,
    RouteAudit,
    // Registration order is execution order.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
