import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import type { ApiRequest } from './api-key.guard.js';

/** Per-key fixed-window limit (T187): Redis INCR + EXPIRE 60 s; 429 with Retry-After. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const key = http.getRequest<ApiRequest>().apiKey;
    if (!key) throw AppError.unauthorized('Missing or invalid API key');
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const redisKey = `wbm:ratelimit:${key.id}:${window}`;
    // One atomic round trip; EXPIRE NX sets the TTL only on the window's first request.
    const reply = await this.redis.multi().incr(redisKey).expire(redisKey, 60, 'NX').exec();
    const [incrError, incrResult] = reply?.[0] ?? [new Error('Rate limit counter unavailable'), null];
    if (incrError) throw incrError;
    const count = Number(incrResult);

    const res = http.getResponse<Response>();
    res.setHeader('X-RateLimit-Limit', String(key.rateLimitPerMinute));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, key.rateLimitPerMinute - count)));
    if (count > key.rateLimitPerMinute) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000))));
      throw AppError.tooManyRequests(`This API key allows ${key.rateLimitPerMinute} requests per minute`);
    }
    return true;
  }
}
