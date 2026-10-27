/**
 * The ingest service's configuration, read once. Every read is `env.NAME`
 * literally so scripts/env-contract.mjs can see it.
 */
export interface IngestConfig {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  /** At most this many events per write transaction (group commit). */
  flushRows: number;
  version: string;
}

export class ConfigError extends Error {}

function int(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name}=${raw} must be an integer in ${String(min)}..${String(max)}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  const redisUrl = env.REDIS_URL?.trim() ?? '';
  if (databaseUrl === '') problems.push('DATABASE_URL is required');
  if (redisUrl === '') problems.push('REDIS_URL is required');
  if (problems.length > 0) throw new ConfigError(problems.join('; '));
  return {
    databaseUrl,
    redisUrl,
    port: int('INGEST_PORT', env.INGEST_PORT, 4200, 1, 65535),
    flushRows: int('INGEST_FLUSH_ROWS', env.INGEST_FLUSH_ROWS, 1000, 1, 20_000),
    version: env.APP_VERSION?.trim() || 'dev',
  };
}
