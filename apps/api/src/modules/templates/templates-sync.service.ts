import { Injectable, Logger } from '@nestjs/common';
import { extractTemplateVariables, metaKindOf, ttlAfterCategoryChange, ttlAppliedByFor } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma, Template } from '../../generated/prisma/client.js';
import { describeMetaError } from '../meta/meta-error-classifier.js';
import { MetaApiError, MetaGraphClient, type MetaTemplate } from '../meta/meta-graph.client.js';
import { NumbersService } from '../numbers/numbers.service.js';

// Template sync from Meta (FR-016, T088) and read endpoints (T089).

type Status = Template['status'];
type Category = Template['category'];

const STATUS_MAP: Record<string, Status> = {
  APPROVED: 'APPROVED',
  REINSTATED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  ARCHIVED: 'DISABLED',
  LIMIT_EXCEEDED: 'DISABLED',
  PENDING_DELETION: 'DELETED',
  DELETED: 'DELETED',
};

export function mapTemplateStatus(status: string): Status {
  return STATUS_MAP[status.toUpperCase()] ?? 'PENDING';
}

export function mapTemplateCategory(category: string): Category {
  const upper = category.toUpperCase();
  return upper === 'UTILITY' || upper === 'AUTHENTICATION' ? upper : 'MARKETING';
}

export const TemplateListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'DELETED']).optional(),
  wabaId: z.string().trim().min(1).optional(),
  /** Templates usable from this number (its WABA); for live chat, where agents cannot list numbers. */
  numberId: z.uuid().optional(),
});
export type TemplateListQuery = z.infer<typeof TemplateListQuerySchema>;

export function toTemplateDto(t: Template) {
  return {
    id: t.id,
    wabaId: t.wabaId,
    metaTemplateId: t.metaTemplateId,
    name: t.name,
    language: t.language,
    category: t.category,
    parameterFormat: t.parameterFormat,
    status: t.status,
    rejectionReason: t.rejectionReason,
    components: Array.isArray(t.components) ? t.components : [],
    variables: Array.isArray(t.variables) ? t.variables : [],
    lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
    updatedAt: t.updatedAt.toISOString(),
    // Feature 009
    kind: t.kind,
    ttlSeconds: t.ttlSeconds,
    ttlAppliedBy: t.ttlAppliedBy,
    options: t.options ?? {},
  };
}

function syncFields(t: MetaTemplate, now: Date) {
  const status = mapTemplateStatus(t.status);
  const rejected = t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null;
  return {
    metaTemplateId: t.id,
    category: mapTemplateCategory(t.category),
    parameterFormat: t.parameter_format?.toUpperCase() === 'NAMED' ? ('NAMED' as const) : ('POSITIONAL' as const),
    components: (t.components ?? []) as unknown as Prisma.InputJsonValue,
    variables: extractTemplateVariables(t.components ?? []) as unknown as Prisma.InputJsonValue,
    status,
    rejectionReason: status === 'REJECTED' ? rejected : null,
    lastSyncedAt: now,
    // Feature 009: the kind follows Meta's components (contracts/meta-templates.md §1).
    kind: metaKindOf(t.category, t.components),
  };
}

@Injectable()
export class TemplatesSyncService {
  private readonly logger = new Logger(TemplatesSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly numbers: NumbersService,
  ) {}

  async list(query: TemplateListQuery) {
    let wabaId = query.wabaId;
    if (query.numberId) {
      const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: query.numberId }, select: { wabaId: true } });
      if (!number || (wabaId && wabaId !== number.wabaId)) return [];
      wabaId = number.wabaId;
    }
    const rows = await this.prisma.template.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...(wabaId ? { wabaId } : {}) },
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
    });
    return rows.map(toTemplateDto);
  }

  async get(id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw AppError.notFound('Template not found');
    return toTemplateDto(template);
  }

  /** Syncs one account (e.g. when Meta reports a template we do not know yet). */
  async syncWaba(wabaId: string): Promise<{ created: number; updated: number }> {
    const number = await this.prisma.whatsAppNumber.findFirst({ where: { wabaId, connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
    if (!number) return { created: 0, updated: 0 };
    return this.upsertAll(wabaId, await this.meta.listAllTemplates(this.numbers.token(number), wabaId));
  }

  /** Syncs every WABA that has a connected number, using that number's token. */
  async syncAll(): Promise<{ created: number; updated: number }> {
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
    const byWaba = new Map<string, (typeof numbers)[number]>();
    for (const n of numbers) if (!byWaba.has(n.wabaId)) byWaba.set(n.wabaId, n);
    if (!byWaba.size) throw AppError.conflict('Connect a WhatsApp number before syncing templates');

    let created = 0;
    let updated = 0;
    const failures: string[] = [];
    for (const [wabaId, number] of byWaba) {
      let templates: MetaTemplate[];
      try {
        templates = await this.meta.listAllTemplates(this.numbers.token(number), wabaId);
      } catch (error) {
        const reason = error instanceof MetaApiError ? describeMetaError(error.code, error.message) : 'Could not reach Meta';
        failures.push(`${wabaId}: ${reason}`);
        this.logger.warn({ wabaId, reason }, 'Template sync failed');
        continue;
      }
      const result = await this.upsertAll(wabaId, templates);
      created += result.created;
      updated += result.updated;
    }
    if (failures.length === byWaba.size) {
      throw AppError.validation(`Template sync failed: ${failures.join('; ')}`, undefined, 'META_ERROR');
    }
    return { created, updated };
  }

  private async upsertAll(wabaId: string, templates: MetaTemplate[]): Promise<{ created: number; updated: number }> {
    const now = new Date();
    let created = 0;
    let updated = 0;
    for (const t of templates) {
      const key = { wabaId_name_language: { wabaId, name: t.name, language: t.language } };
      const fields = syncFields(t, now);
      const existing = await this.prisma.template.findUnique({ where: key, select: { id: true, ttlSeconds: true } });
      if (existing) {
        // When Meta changed the category, a TTL that no longer fits is cleared (research R8).
        const ttl = ttlAfterCategoryChange(fields.category, existing.ttlSeconds);
        await this.prisma.template.update({ where: { id: existing.id }, data: { ...fields, ttlSeconds: ttl, ttlAppliedBy: ttl === null ? null : ttlAppliedByFor(fields.category) } });
        updated++;
      } else {
        await this.prisma.template.create({ data: { wabaId, name: t.name, language: t.language, ...fields } });
        created++;
      }
    }
    // Templates deleted in Meta disappear from the listing.
    await this.prisma.template.updateMany({
      where: { wabaId, metaTemplateId: { not: null }, status: { not: 'DELETED' }, lastSyncedAt: { lt: now } },
      data: { status: 'DELETED' },
    });
    return { created, updated };
  }
}
