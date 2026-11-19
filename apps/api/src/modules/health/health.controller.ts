import { Controller, Get, Inject, Module, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { OpsTokenGuard } from '../../common/auth/ops-token.guard.js';
import { Public } from '../../common/auth/public.decorator.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';

/** GET /api/health: database and Redis checks, 503 when either is down (T053). */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @Public()
  @UseGuards(OpsTokenGuard)
  async check(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(
        () => 'ok',
        () => 'down',
      ),
      this.redis.ping().then(
        () => 'ok',
        () => 'down',
      ),
    ]);
    const healthy = db === 'ok' && redis === 'ok';
    res.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', db, redis };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
