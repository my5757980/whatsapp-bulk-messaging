import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

const WINDOW_MS = 15 * 60_000;
const MIN_ATTEMPTS = 10;
const ALERT_KEY = 'wbm:ai:failing-alert';
const ALERT_GAP_SECONDS = 3600;

/**
 * FR-022: when more than 20% of at least 10 AI attempts in the last 15 minutes failed (fallback
 * replies), admins get one AI_FAILING notification, at most once an hour.
 */
@Injectable()
export class AiFailureMonitor {
  private readonly logger = new Logger(AiFailureMonitor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly notifications: NotificationsService,
  ) {}

  /** True when this check sent the alert. */
  async check(now: Date = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - WINDOW_MS);
    const [attempts, failed] = await Promise.all([
      this.prisma.aiReply.count({ where: { createdAt: { gte: since } } }),
      this.prisma.aiReply.count({ where: { createdAt: { gte: since }, kind: 'FALLBACK' } }),
    ]);
    if (attempts < MIN_ATTEMPTS || failed * 5 <= attempts) return false;
    if (!(await this.redis.set(ALERT_KEY, '1', 'EX', ALERT_GAP_SECONDS, 'NX'))) return false;
    this.logger.warn({ attempts, failed }, 'AI replies are failing');
    await this.notifications.notifyAdmins({
      type: 'AI_FAILING',
      title: 'AI agent replies are failing',
      body: `${failed} of the last ${attempts} AI replies failed in 15 minutes. Those customers got the fallback message and wait for a person.`,
      link: '/ai-agents',
    });
    return true;
  }
}
