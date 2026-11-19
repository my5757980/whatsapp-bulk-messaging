import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { Role } from '../../../generated/prisma/client.js';
import { presenceKey } from '../realtime/stream-fanout.service.js';
import { PUSH_SENDER, type PushSender } from './push-sender.js';

/** Alerts older than a minute are useless for live chat, so the push service may drop them. */
export const PUSH_TTL_SECONDS = 60;

export interface PushRecipient {
  id: string;
  role: Role;
}

/** What the service worker shows (apps/web/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Opened on click. */
  url: string;
  /** One alert per chat on a device: a newer alert replaces the older one. */
  tag: string;
}

/**
 * Browser push for live chat (T087, FR-037, research R9). Members with the dashboard open (the SSE
 * presence key) are skipped; paused devices get nothing; a 404 or 410 from the push service means
 * the browser dropped the subscription, so the device is deleted.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  get enabled(): boolean {
    return this.sender.enabled;
  }

  /** Returns the number of devices reached. */
  async send(recipients: readonly PushRecipient[], payloadFor: (recipient: PushRecipient) => PushPayload): Promise<number> {
    if (!this.sender.enabled || recipients.length === 0) return 0;
    const present = await this.redis.mget(recipients.map((r) => presenceKey(r.id)));
    const away = new Map(recipients.filter((_, i) => present[i] === null).map((r) => [r.id, r]));
    if (away.size === 0) return 0;
    const devices = await this.prisma.pushDevice.findMany({ where: { userId: { in: [...away.keys()] }, paused: false } });
    const delivered = await Promise.all(devices.map((device) => this.deliver(device, payloadFor(away.get(device.userId)!))));
    return delivered.filter(Boolean).length;
  }

  private async deliver(device: { id: string; endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<boolean> {
    try {
      await this.sender.send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, JSON.stringify(payload), { TTL: PUSH_TTL_SECONDS });
      await this.prisma.pushDevice.updateMany({ where: { id: device.id }, data: { lastSuccessAt: new Date() } });
      return true;
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (status === 404 || status === 410) {
        await this.prisma.pushDevice.deleteMany({ where: { id: device.id } });
      } else {
        this.logger.warn({ err: (error as Error).message, status, deviceId: device.id }, 'Push alert not delivered');
      }
      return false;
    }
  }
}
