import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { AppError } from '../../common/errors/app-error.js';
import { PhoneField } from '../../common/interceptors/phone-mask.interceptor.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema, pageMeta } from '../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Prisma, type Message } from '../../generated/prisma/client.js';
import { DELIVERED, REPLIED } from './replied.sql.js';

const MessagesQuerySchema = PageQuerySchema.extend({
  status: z.enum(['PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED', 'EXPIRED']).optional(),
  /** Feature 009 (research R11): delivered messages that got a reply (true) or none (false). */
  replied: z.enum(['true', 'false']).optional(),
});
type MessagesQuery = z.infer<typeof MessagesQuerySchema>;

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Response shape (contract `Message`); `phone` is masked for agents by PhoneMaskInterceptor. */
export function toMessageDto(m: Message & { contact?: { name: string | null } | null }) {
  return {
    id: m.id,
    origin: m.origin,
    phone: m.phoneE164,
    contactId: m.contactId,
    contactName: m.contact?.name ?? null,
    status: m.status,
    skipReason: m.skipReason,
    expiredReason: m.expiredReason,
    failureCode: m.failureCode,
    failureReason: m.failureReason,
    attempts: m.attempts,
    sentAt: iso(m.sentAt),
    deliveredAt: iso(m.deliveredAt),
    readAt: iso(m.readAt),
    failedAt: iso(m.failedAt),
    costUsd: m.costUsdMicros === null ? null : Number(m.costUsdMicros) / 1_000_000,
  };
}

/** GET /campaigns/{id}/messages (T106). */
@Controller('campaigns')
export class CampaignMessagesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id/messages')
  @Require('campaigns.view')
  @PhoneField('phone')
  async list(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(MessagesQuerySchema)) query: MessagesQuery) {
    if (!(await this.prisma.campaign.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound('Campaign not found');
    if (query.replied) return this.byReply(id, query);
    const where = { campaignId: id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { contact: { select: { name: true } } },
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.message.count({ where }),
    ]);
    return { items: items.map(toMessageDto), page: pageMeta(query, total) };
  }

  /** The Replied / Not replied lists, with the same rule as the 005 retarget groups. */
  private async byReply(id: string, query: MessagesQuery) {
    const reply = query.replied === 'true' ? REPLIED : Prisma.sql`NOT ${REPLIED}`;
    const status = query.status ? Prisma.sql`AND m.status = ${query.status}::"MessageStatus"` : Prisma.empty;
    const condition = Prisma.sql`m.campaign_id = ${id}::uuid AND m.contact_id IS NOT NULL AND ${DELIVERED} AND ${reply} ${status}`;
    const [ids, counted] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`SELECT m.id FROM messages m WHERE ${condition} ORDER BY m.id OFFSET ${(query.page - 1) * query.pageSize} LIMIT ${query.pageSize}`,
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM messages m WHERE ${condition}`,
    ]);
    const items = await this.prisma.message.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: { contact: { select: { name: true } } }, orderBy: { id: 'asc' } });
    return { items: items.map(toMessageDto), page: pageMeta(query, counted[0]?.n ?? 0) };
  }
}
