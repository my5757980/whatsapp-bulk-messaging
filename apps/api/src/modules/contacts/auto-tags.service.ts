import { Injectable } from '@nestjs/common';
import { LEAD_SOURCE_KINDS, type LeadSourceKind } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { AutoTagEvent, Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { DripEvents } from '../growth/drips/drip-events.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';

// Feature 010 (research R4, FR-010): tags added when something happens. Rules only see events after they
// are saved and never remove tags; a tag removed by hand comes back only when the event happens again.

export const AutoTagRuleInputSchema = z
  .object({
    event: z.enum(['CONTACT_CREATED', 'CAMPAIGN_REPLY', 'LINK_CLICK', 'OPTED_IN', 'OPTED_OUT']),
    leadSource: z.enum(LEAD_SOURCE_KINDS).optional(),
    tagId: z.uuid(),
  })
  .strict()
  .refine((v) => (v.event === 'CONTACT_CREATED') === (v.leadSource !== undefined), { message: 'a new-contact rule names its lead source; other rules do not', path: ['leadSource'] });
export type AutoTagRuleInput = z.infer<typeof AutoTagRuleInputSchema>;

interface CachedRule {
  event: AutoTagEvent;
  leadSourceKind: LeadSourceKind | null;
  tagId: string;
}

type Db = PrismaService | Prisma.TransactionClient;
const CACHE_MS = 30_000;

@Injectable()
export class AutoTagService {
  private cache: { at: number; rules: CachedRule[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
  ) {}

  /** Whether any switched-on rule listens to the event (checked before costlier work). */
  async listens(event: AutoTagEvent): Promise<boolean> {
    return (await this.rules()).some((r) => r.event === event);
  }

  /** Adds the tags of the rules for this event; returns how many tags were added. */
  async apply(db: Db, event: AutoTagEvent, contactId: string, leadSource?: LeadSourceKind): Promise<number> {
    const rules = (await this.rules()).filter((r) => r.event === event && (event !== 'CONTACT_CREATED' || r.leadSourceKind === leadSource));
    if (!rules.length) return 0;
    const links = await db.contactTag.createManyAndReturn({ data: rules.map((r) => ({ contactId, tagId: r.tagId })), skipDuplicates: true, select: { contactId: true, tagId: true } });
    if (links.length) {
      // As for other added tags: drips that start on the tag and webhook endpoints (005, 006).
      await this.dripEvents.recordTagAddedToMany(db, links);
      await this.platformEvents.tagLinksChanged(db, links);
    }
    return links.length;
  }

  /** The same for many new contacts with one lead source (imports and uploads). */
  async applyToMany(db: Db, event: AutoTagEvent, contactIds: readonly string[], leadSource?: LeadSourceKind): Promise<number> {
    if (!contactIds.length) return 0;
    const rules = (await this.rules()).filter((r) => r.event === event && (event !== 'CONTACT_CREATED' || r.leadSourceKind === leadSource));
    if (!rules.length) return 0;
    const links = await db.contactTag.createManyAndReturn({ data: contactIds.flatMap((contactId) => rules.map((r) => ({ contactId, tagId: r.tagId }))), skipDuplicates: true, select: { contactId: true, tagId: true } });
    if (links.length) {
      await this.dripEvents.recordTagAddedToMany(db, links);
      await this.platformEvents.tagLinksChanged(db, links);
    }
    return links.length;
  }

  async list() {
    const rows = await this.prisma.autoTagRule.findMany({ include: { tag: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    return { items: rows.map((r) => ({ id: r.id, event: r.event, leadSource: r.leadSourceKind, tagId: r.tagId, tagName: r.tag.name, enabled: r.enabled, createdAt: r.createdAt.toISOString() })) };
  }

  async create(input: AutoTagRuleInput, actor: AuditActor) {
    if (!(await this.prisma.tag.findUnique({ where: { id: input.tagId }, select: { id: true } }))) throw AppError.validation('Tag not found', [{ field: 'tagId', issue: 'does not exist' }]);
    try {
      const row = await this.prisma.autoTagRule.create({ data: { event: input.event, leadSourceKind: input.leadSource ?? null, tagId: input.tagId, createdById: actor.userId ?? null }, include: { tag: { select: { name: true } } } });
      this.cache = null;
      await this.audit.record(actor, 'auto_tag_rule.changed', { type: 'auto_tag_rule', id: row.id }, { change: 'created', event: row.event, leadSource: row.leadSourceKind, tag: row.tag.name });
      return { id: row.id, event: row.event, leadSource: row.leadSourceKind, tagId: row.tagId, tagName: row.tag.name, enabled: row.enabled, createdAt: row.createdAt.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('This rule exists already', 'RULE_EXISTS');
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean, actor: AuditActor) {
    const row = await this.prisma.autoTagRule.findUnique({ where: { id }, include: { tag: { select: { name: true } } } });
    if (!row) throw AppError.notFound('Rule not found');
    const updated = await this.prisma.autoTagRule.update({ where: { id }, data: { enabled }, include: { tag: { select: { name: true } } } });
    this.cache = null;
    await this.audit.record(actor, 'auto_tag_rule.changed', { type: 'auto_tag_rule', id }, { change: enabled ? 'switched_on' : 'switched_off', event: row.event, tag: row.tag.name });
    return { id: updated.id, event: updated.event, leadSource: updated.leadSourceKind, tagId: updated.tagId, tagName: updated.tag.name, enabled: updated.enabled, createdAt: updated.createdAt.toISOString() };
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.prisma.autoTagRule.findUnique({ where: { id }, include: { tag: { select: { name: true } } } });
    if (!row) throw AppError.notFound('Rule not found');
    await this.prisma.autoTagRule.delete({ where: { id } });
    this.cache = null;
    await this.audit.record(actor, 'auto_tag_rule.changed', { type: 'auto_tag_rule', id }, { change: 'deleted', event: row.event, tag: row.tag.name });
  }

  private async rules(): Promise<CachedRule[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rules;
    const rules = await this.prisma.autoTagRule.findMany({ where: { enabled: true }, select: { event: true, leadSourceKind: true, tagId: true } });
    this.cache = { at: Date.now(), rules };
    return rules;
  }
}
