import { Controller, Get, Global, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { NotificationType } from '@wbm/shared';
import { CurrentUser, type RequestUser } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

/** In-app notifications (FR-038, T051). Admin notifications are fanned out, one row per admin. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notifyAdmins(input: NotificationInput): Promise<number> {
    const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
    if (!admins.length) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: admins.map((a) => ({ userId: a.id, type: input.type, title: input.title, body: input.body, link: input.link ?? null })),
    });
    return count;
  }

  async listForUser(userId: string, limit = 50) {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  async markRead(id: string, userId: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId } }))) {
      throw AppError.notFound('Notification not found');
    }
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.notifications.listForUser(user.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  async markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser): Promise<void> {
    await this.notifications.markRead(id, user.id);
  }
}

@Global()
@Module({ providers: [NotificationsService], controllers: [NotificationsController], exports: [NotificationsService] })
export class NotificationsModule {}
