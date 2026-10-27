import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { AdmissionControl } from './admission';
import { loadConfig } from './config';
import { INVALIDATE_CHANNEL, KeyDirectory } from './directory';
import { buildServer } from './server';
import { BatchWriter } from './writer';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const directory = new KeyDirectory(pool);
  const writer = new BatchWriter(pool, config.flushRows);

  await subscriber.subscribe(INVALIDATE_CHANNEL);
  subscriber.on('message', (_channel: string, tenantId: string) =>
    directory.invalidateTenant(tenantId),
  );

  const app = buildServer({
    pool,
    redis,
    directory,
    admission: new AdmissionControl(redis),
    writer,
    version: config.version,
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  process.stdout.write(
    `${JSON.stringify({ service: 'ingest', event: 'listening', port: config.port })}\n`,
  );

  const shutdown = async () => {
    // Stop taking requests, write what is buffered, then close.
    await app.close();
    await writer.flushAll();
    await Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ service: 'ingest', event: 'fatal', error: String(error) })}\n`,
  );
  process.exit(1);
});
