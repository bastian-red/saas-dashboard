/**
 * The only way application code reaches tenant data through Prisma.
 *
 * Opens a transaction, sets `app.tenant_id` for exactly that transaction
 * (`set_config(..., true)`: LOCAL, so it dies at COMMIT and a pooled connection
 * never carries one request's tenant into the next), and hands the transaction
 * client to `fn`. Every row `fn` can see or write is the tenant's, enforced by
 * the policies, not by `fn` remembering a WHERE clause.
 *
 * The id is validated before it reaches the database: a malformed id would make
 * the policy's `::uuid` cast throw inside every statement, which is a confusing
 * 500 rather than a refusal.
 */
import type { Prisma, PrismaClient } from '../generated/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type TenantTx = Prisma.TransactionClient;

export class TenantContextError extends Error {}

export async function withTenant<T>(
  client: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new TenantContextError(`not a tenant id: ${tenantId}`);
  return client.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 10_000, maxWait: 5_000 },
  );
}
