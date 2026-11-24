import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Per-client limit for the public tracked-link route (research R1, R3): a fixed one-minute window in
 * Redis, keyed by a salted hash of the client's address so the address itself is never stored. When
 * Redis is unavailable everyone is let through: a visitor must always reach the destination.
 */
export class LinkRateLimiter {
  static readonly PER_MINUTE = 120;

  constructor(
    private readonly redis: Redis,
    private readonly salt: string,
  ) {}

  async allow(ip: string | undefined): Promise<boolean> {
    if (!ip) return true;
    const window = Math.floor(Date.now() / 60_000);
    const client = createHmac('sha256', this.salt).update(`link-rate:${ip}`).digest('hex').slice(0, 32);
    const key = `wbm:linkrate:${client}:${window}`;
    try {
      const reply = await this.redis.multi().incr(key).expire(key, 60, 'NX').exec();
      const [error, count] = reply?.[0] ?? [new Error('no reply'), null];
      if (error) return true;
      return Number(count) <= LinkRateLimiter.PER_MINUTE;
    } catch {
      return true;
    }
  }
}
