/**
 * `GET /status`: the health of the api, ingest and aggregator services, for the
 * web app's /status page. Each sibling is asked over HTTP: a process that is
 * wedged answers nothing, and that is what this page must show. Public, like
 * /health: it reports state, never data.
 */
import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { healthSchema, type Health, type Status } from '@saas/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { Public } from '../common/session.guard';
import { HealthService } from '../health/health.service';

type Unreachable = { service: 'ingest' | 'aggregator'; status: 'unreachable'; detail: string };

export async function sibling(
  service: 'ingest' | 'aggregator',
  base: string,
): Promise<Health | Unreachable> {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    const parsed = healthSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
    return { service, status: 'unreachable', detail: 'answered /health in an unexpected shape' };
  } catch (error) {
    // The error CLASS or code, never the message: a connection error's message
    // carries the internal host and port, and this endpoint is public.
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return {
      service,
      status: 'unreachable',
      detail: typeof code === 'string' ? code : error instanceof Error ? error.name : 'Error',
    };
  }
}

@Controller('status')
export class StatusController {
  constructor(
    private readonly health: HealthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @SkipThrottle({ default: true, auth: true, invite: true })
  @Get()
  async status(): Promise<Status> {
    const [api, ingest, aggregator] = await Promise.all([
      this.health.report(),
      sibling('ingest', this.config.ingestInternalUrl),
      sibling('aggregator', this.config.aggregatorInternalUrl),
    ]);
    return { checkedAt: new Date().toISOString(), services: [api, ingest, aggregator] };
  }
}
