import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

export const CHAT_WIDGET_CHECK_JOB = 'chat-widget-check';
const EVERY_MS = 5 * 60_000;

/**
 * Feature 009 (FR-044): a website button whose number is not connected is hidden on the website. Every
 * 5 minutes admins are told once per disconnection; the mark clears when the number is connected again.
 */
@Injectable()
export class ChatWidgetCheckProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ChatWidgetCheckProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, CHAT_WIDGET_CHECK_JOB, () => this.check());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler(CHAT_WIDGET_CHECK_JOB, { every: EVERY_MS }, { name: CHAT_WIDGET_CHECK_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  /** Returns how many buttons were reported. */
  async check(): Promise<number> {
    const widgets = await this.prisma.chatWidget.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, disconnectNotifiedAt: true, number: { select: { label: true, connectionStatus: true } } },
    });
    let reported = 0;
    for (const w of widgets) {
      const connected = w.number.connectionStatus === 'CONNECTED';
      if (!connected && !w.disconnectNotifiedAt) {
        const { count } = await this.prisma.chatWidget.updateMany({ where: { id: w.id, disconnectNotifiedAt: null }, data: { disconnectNotifiedAt: new Date() } });
        if (!count) continue;
        await this.notifications.notifyAdmins({
          type: 'CHAT_WIDGET_NUMBER_DISCONNECTED',
          title: 'A website chat button is hidden',
          body: `"${w.name}" is hidden on the website because its number "${w.number.label}" is not connected.`,
          link: `/website-button/${w.id}`,
        });
        reported++;
      } else if (connected && w.disconnectNotifiedAt) {
        await this.prisma.chatWidget.update({ where: { id: w.id }, data: { disconnectNotifiedAt: null } });
      }
    }
    if (reported) this.logger.warn({ reported }, 'Website buttons hidden by a disconnected number');
    return reported;
  }
}
