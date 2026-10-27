import { z } from 'zod';

import {
  emailSchema,
  hexColourSchema,
  idSchema,
  nameSchema,
  tenantIdSchema,
  workspaceSlugSchema,
} from './primitives';
import { planIdSchema, subscriptionStatusSchema } from './plans';
import { roleSchema } from './roles';

export const workspaceSchema = z.object({
  id: tenantIdSchema,
  slug: workspaceSlugSchema,
  name: nameSchema,
  role: roleSchema,
  plan: planIdSchema,
  /** The tenant's accent, already validated and stepped for both schemes; null = product default. */
  branding: z
    .object({
      light: z.object({ accent: hexColourSchema, ink: hexColourSchema, soft: hexColourSchema }),
      dark: z.object({ accent: hexColourSchema, ink: hexColourSchema, soft: hexColourSchema }),
    })
    .nullable(),
});

export const createWorkspaceSchema = z
  .object({ name: nameSchema, slug: workspaceSlugSchema })
  .strict();

export const memberSchema = z.object({
  userId: idSchema,
  email: emailSchema,
  name: nameSchema,
  role: roleSchema,
  joinedAt: z.string().datetime(),
});

export const inviteSchema = z.object({
  id: idSchema,
  email: emailSchema,
  role: roleSchema,
  expiresAt: z.string().datetime(),
});

export const createInviteSchema = z.object({ email: emailSchema, role: roleSchema }).strict();
export const changeRoleSchema = z.object({ role: roleSchema }).strict();

/** Returned once, at creation: the invite link carries the raw token, the database only its hash. */
export const createdInviteSchema = inviteSchema.extend({ token: z.string() });

export const apiKeySchema = z.object({
  id: idSchema,
  name: z.string(),
  /** The first 12 characters, so a key can be recognised in a list. */
  prefix: z.string(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
});
export const createApiKeySchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
/** The full key, shown exactly once. */
export const createdApiKeySchema = apiKeySchema.extend({ key: z.string() });

export const brandingInputSchema = z.object({ accent: hexColourSchema.nullable() }).strict();

export const billingSchema = z.object({
  plan: planIdSchema,
  status: subscriptionStatusSchema.nullable(),
  effectivePlan: planIdSchema,
  seatsUsed: z.number().int().nonnegative(),
  eventsThisMonth: z.number().int().nonnegative(),
  currentPeriodEnd: z.string().datetime().nullable(),
});

export const checkoutSchema = z.object({ plan: planIdSchema.exclude(['free']) }).strict();
export const redirectUrlSchema = z.object({ url: z.string().url() });

export type Workspace = z.infer<typeof workspaceSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type Billing = z.infer<typeof billingSchema>;
