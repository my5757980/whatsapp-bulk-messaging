import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { PhoneField } from '../../common/interceptors/phone-mask.interceptor.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema, pageMeta } from '../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { toMessageDto } from '../campaigns/campaign-messages.controller.js';

const ApiMessagesQuerySchema = PageQuerySchema.extend({ apiKeyId: z.uuid().optional() });
type ApiMessagesQuery = z.infer<typeof ApiMessagesQuerySchema>;

/** GET /api-messages (T191): log of messages sent through the public API; phones masked for agents. */
@Controller('api-messages')
export class ApiMessagesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('campaigns.view')
  @PhoneField('phone')
  async list(@Query(new ZodValidationPipe(ApiMessagesQuerySchema)) query: ApiMessagesQuery) {
    const where = { origin: 'API' as const, ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { contact: { select: { name: true } }, template: { select: { name: true, language: true } }, apiKey: { select: { name: true } } },
        orderBy: { id: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.message.count({ where }),
    ]);
    return {
      items: items.map((m) => ({
        ...toMessageDto(m),
        templateName: m.template.name,
        templateLanguage: m.template.language,
        apiKeyId: m.apiKeyId,
        apiKeyName: m.apiKey?.name ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
      page: pageMeta(query, total),
    };
  }
}
