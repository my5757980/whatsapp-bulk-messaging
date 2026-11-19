import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema, pageMeta } from '../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { Prisma } from '../../generated/prisma/client.js';

const AuditQuerySchema = PageQuerySchema.extend({
  action: z.string().trim().min(1).max(60).optional(),
  actorUserId: z.uuid().optional(),
});
type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** GET /audit-logs (FR-008, T174): admins only, newest first, filter by action and actor. */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('audit.view')
  async list(@Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { actorUser: { select: { name: true } }, actorApiKey: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id,
        actorType: e.actorUserId ? 'USER' : e.actorApiKeyId ? 'API_KEY' : 'SYSTEM',
        actorName: e.actorUser?.name ?? e.actorApiKey?.name ?? null,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        metadata: (e.metadata ?? {}) as Record<string, unknown>,
        ip: e.ip,
        createdAt: e.createdAt.toISOString(),
      })),
      page: pageMeta(query, total),
    };
  }
}
