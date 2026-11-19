import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';

export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/** Fixed-window login throttle: 10 failed attempts per 15 min per email + IP (T044). */
@Injectable()
export class LoginThrottleService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(email: string, ip: string | undefined): string {
    return `login-attempts:${email}:${ip ?? 'unknown'}`;
  }

  /** Throws 429 when the window is exhausted. */
  async assertAllowed(email: string, ip: string | undefined): Promise<void> {
    const attempts = Number((await this.redis.get(this.key(email, ip))) ?? 0);
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      throw AppError.tooManyRequests('Too many sign-in attempts. Try again later.');
    }
  }

  async recordFailure(email: string, ip: string | undefined): Promise<void> {
    const key = this.key(email, ip);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, LOGIN_WINDOW_SECONDS);
  }

  async reset(email: string, ip: string | undefined): Promise<void> {
    await this.redis.del(this.key(email, ip));
  }
}
