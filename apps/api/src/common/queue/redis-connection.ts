/** BullMQ connection options parsed from REDIS_URL (BullMQ needs maxRetriesPerRequest: null). */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export function redisOptionsFromUrl(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(db !== undefined && !Number.isNaN(db) ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
