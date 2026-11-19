import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { AppError } from '../../common/errors/app-error.js';
import { PhoneField } from '../../common/interceptors/phone-mask.interceptor.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema, pageMeta } from '../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { Message } from '../../generated/prisma/client.js';

const MessagesQuerySchema = PageQuerySchema.extend({
  status: z.enum(['PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED']).optional(),
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
}
