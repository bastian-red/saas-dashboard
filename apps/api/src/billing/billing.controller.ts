import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { brandingInputSchema, checkoutSchema, type Billing, type SessionUser } from '@saas/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { Public, CurrentUser } from '../common/session.guard';
import { ZodPipe } from '../common/zod.pipe';
import { Requires, Tenant, type TenantContext } from '../tenancy/tenant.guard';
import { BillingService } from './billing.service';

const mockSchema = z
  .object({
    plan: z.enum(['team', 'business']),
    status: z.enum(['active', 'past_due', 'canceled']).default('active'),
  })
  .strict();

@Controller('workspaces/:workspace')
export class WorkspaceBillingController {
  constructor(private readonly billing: BillingService) {}

  @Requires('billing.read')
  @Get('billing')
  summary(@Tenant() ctx: TenantContext): Promise<Billing> {
    return this.billing.summary(ctx);
  }

  @Requires('billing.write')
  @Post('billing/checkout')
  checkout(
    @Tenant() ctx: TenantContext,
    @CurrentUser() user: SessionUser,
    @Body(new ZodPipe(checkoutSchema)) input: z.infer<typeof checkoutSchema>,
  ) {
    return this.billing.checkout(ctx, user, input.plan);
  }

  @Requires('billing.write')
  @Post('billing/portal')
  portal(@Tenant() ctx: TenantContext) {
    return this.billing.portal(ctx);
  }

  @Requires('billing.write')
  @HttpCode(HttpStatus.OK)
  @Post('billing/mock')
  async mock(
    @Tenant() ctx: TenantContext,
    @Body(new ZodPipe(mockSchema)) input: z.infer<typeof mockSchema>,
  ) {
    return { outcome: await this.billing.mockComplete(ctx, input.plan, input.status) };
  }

  @Requires('branding.write')
  @Put('branding')
  branding(
    @Tenant() ctx: TenantContext,
    @Body(new ZodPipe(brandingInputSchema)) input: z.infer<typeof brandingInputSchema>,
  ) {
    return this.billing.setBranding(ctx, input.accent);
  }
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  /**
   * The provider's webhook. Public (the provider has no session), signed,
   * unthrottled (a provider retrying a backlog must not be refused), and read
   * from the RAW body: a signature is over bytes, and re-serialised JSON is not
   * the same bytes.
   */
  @Public()
  @SkipThrottle({ default: true, auth: true, invite: true })
  @HttpCode(HttpStatus.OK)
  @Post('webhook')
  async webhook(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    return {
      outcome: await this.billing.webhook(request.rawBody ?? Buffer.alloc(0), signature ?? ''),
    };
  }
}
