import { Injectable } from '@nestjs/common';
import { LEAD_SOURCE_KINDS } from '@wbm/shared';
import { z } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/phone/phone.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PageQuerySchema, pageMeta } from '../../common/validation/pagination.js';
import { Prisma, type Contact } from '../../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';
import { validateAttributeValue, type AttributeType, type AttributeValue } from './attribute-validator.js';
import { AudienceFilterSchema, AudienceQueryBuilder } from './audience-query.builder.js';
import { DripEvents } from '../growth/drips/drip-events.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';
import { ConsentService } from './consent.service.js';
import { normaliseTag } from './tags.controller.js';
import { contactFilterSql } from './contact-filter.sql.js';
import { SegmentQueryBuilder } from './segment-query.builder.js';
import { leadSourceFor } from './lead-source.js';
import { AutoTagService } from './auto-tags.service.js';

/** Contacts per transaction when tags are added to many (feature 010 bulk actions). */
const TAG_MANY_CHUNK = 1_000;

// Contacts (FR-009, FR-012, T123). Deletion ships with US1 (ContactDeletionService).

export const ContactInputSchema = z
  .object({
    phone: z.string().trim().min(3).max(32),
    name: z.string().trim().max(120).nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(50),
    attributes: z.record(z.string(), z.unknown()),
    consentStatus: z.enum(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN']),
    /** Feature 010: a custom lead source label for a new contact. */
    leadSourceLabel: z.string().trim().max(80),
    consentSourceNote: z.string().trim().min(3).max(500),
  })
  .partial()
  .strict();
export type ContactInput = z.infer<typeof ContactInputSchema>;
export const CreateContactSchema = ContactInputSchema.required({ phone: true });

const tagList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(normaliseTag).filter(Boolean));

export const ContactListQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  tag: tagList,
  consent: z.enum(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN']).optional(),
  /** Feature 010: the lead source kind (FR-012) and a saved segment (FR-007). */
  leadSource: z.enum(LEAD_SOURCE_KINDS).optional(),
  segmentId: z.uuid().optional(),
});
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;

export const BulkActionSchema = z
  .object({
    contactIds: z.array(z.uuid()).min(1).max(10_000),
    action: z.enum(['ADD_TAG', 'REMOVE_TAG', 'SET_ATTRIBUTE']),
    tag: z.string().trim().min(1).max(50).optional(),
    attributeKey: z.string().trim().min(1).max(40).optional(),
    attributeValue: z.unknown().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.action === 'ADD_TAG' || v.action === 'REMOVE_TAG') && !v.tag) ctx.addIssue({ code: 'custom', path: ['tag'], message: 'is required' });
    if (v.action === 'SET_ATTRIBUTE' && !v.attributeKey) ctx.addIssue({ code: 'custom', path: ['attributeKey'], message: 'is required' });
  });
export type BulkAction = z.infer<typeof BulkActionSchema>;

export const AudiencePreviewSchema = z
  .object({
    filter: AudienceFilterSchema.optional(),
    templateCategory: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
  })
  .strict();
export type AudiencePreviewInput = z.infer<typeof AudiencePreviewSchema>;

type ContactWithTags = Contact & { tags: Array<{ tag: { name: string } }> };

/** Response shape (contract `Contact`); `phone` is masked for agents by PhoneMaskInterceptor. */
export function toContactDto(c: ContactWithTags) {
  return {
    id: c.id,
    phone: c.phoneE164,
    countryCode: c.countryCode,
    name: c.name,
    tags: c.tags.map((t) => t.tag.name).sort(),
    attributes: (c.attributes ?? {}) as Record<string, unknown>,
    consentStatus: c.consentStatus,
    consentSource: c.consentSource,
    consentAt: c.consentAt?.toISOString() ?? null,
    // Feature 010 (FR-012): where the contact first came from.
    leadSource: c.leadSourceKind,
    leadSourceLabel: c.leadSource,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Feature 010: the lead source kind of contacts made by each creation path. */
const LEAD_KIND = { dashboard: 'CUSTOM', api: 'API', store: 'STORE' } as const;

const WITH_TAGS = { tags: { select: { tag: { select: { name: true } } } } } as const;

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly consent: ConsentService,
    private readonly audience: AudienceQueryBuilder,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    private readonly segments: SegmentQueryBuilder,
    private readonly autoTags: AutoTagService,
  ) {}

  private async attributeTypes(): Promise<Map<string, AttributeType>> {
    const defs = await this.prisma.attributeDefinition.findMany({ select: { key: true, type: true } });
    return new Map(defs.map((d) => [d.key, d.type]));
  }

  /** Validates attribute values; `null` means "remove" when `allowNull` is set. */
  private async checkAttributes(input: Record<string, unknown>, allowNull: boolean): Promise<Record<string, AttributeValue | null>> {
    const types = await this.attributeTypes();
    const out: Record<string, AttributeValue | null> = {};
    const errors: ErrorDetail[] = [];
    for (const [key, raw] of Object.entries(input)) {
      const type = types.get(key);
      if (!type) {
        errors.push({ field: `attributes.${key}`, issue: 'is not a defined attribute' });
        continue;
      }
      if (raw === null) {
        if (allowNull) out[key] = null;
        continue;
      }
      const checked = validateAttributeValue(type, raw);
      if (checked.ok) out[key] = checked.value;
      else errors.push({ field: `attributes.${key}`, issue: checked.issue });
    }
    if (errors.length) throw AppError.validation('Invalid attribute values', errors);
    return out;
  }

  private async normalise(phone: string) {
    const { defaultCountryCode } = await this.settings.get();
    const normalised = normalizePhone(phone, defaultCountryCode);
    if (!normalised) throw AppError.validation('Invalid phone number', [{ field: 'phone', issue: 'is not a valid phone number' }]);
    return normalised;
  }

  private requireNoteForOptIn(input: ContactInput): void {
    if (input.consentStatus === 'OPTED_IN' && !input.consentSourceNote) {
      throw AppError.validation('Record where the contact opted in', [{ field: 'consentSourceNote', issue: 'is required to record an opt-in' }]);
    }
  }

  private async setTags(tx: Prisma.TransactionClient, contactId: string, names: string[]): Promise<void> {
    const wanted = [...new Set(names.map(normaliseTag).filter(Boolean))];
    if (wanted.length) {
      await tx.tag.createMany({ data: wanted.map((name) => ({ name })), skipDuplicates: true });
    }
    const tags = wanted.length ? await tx.tag.findMany({ where: { name: { in: wanted } }, select: { id: true } }) : [];
    // Removed tags are noted only when a webhook endpoint listens (feature 006, FR-002).
    const removed = (await this.platformEvents.listens('contact.tags_changed'))
      ? await tx.contactTag.findMany({ where: { contactId, tagId: { notIn: tags.map((t) => t.id) } }, select: { contactId: true, tagId: true } })
      : [];
    await tx.contactTag.deleteMany({ where: { contactId, tagId: { notIn: tags.map((t) => t.id) } } });
    const added = tags.length
      ? await tx.contactTag.createManyAndReturn({ data: tags.map((t) => ({ contactId, tagId: t.id })), skipDuplicates: true, select: { contactId: true, tagId: true } })
      : [];
    // Tags newly added can start drips and apply their stop tags (feature 005, FR-024, FR-028).
    if (added.length) await this.dripEvents.recordTagsAdded(tx, contactId, added.map((a) => a.tagId));
    await this.platformEvents.tagLinksChanged(tx, added, removed);
  }

  async get(id: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
      include: { ...WITH_TAGS, consentEvents: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
    if (!contact) throw AppError.notFound('Contact not found');
    return {
      ...toContactDto(contact),
      consentHistory: contact.consentEvents.map((e) => ({ status: e.status, source: e.source, note: e.note, createdAt: e.createdAt.toISOString() })),
    };
  }

  async list(query: ContactListQuery) {
    if (query.segmentId) return this.listInSegment(query, query.segmentId);
    const and: Prisma.ContactWhereInput[] = [];
    if (query.q) {
      // Phone search only for phone-like input ("+971 50…", "4440001"); otherwise search names.
      const digits = query.q.replace(/\D/g, '');
      const phoneLike = /^[+\d\s().-]+$/.test(query.q) && digits.length >= 3;
      and.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          ...(phoneLike ? [{ phoneE164: { contains: digits } }] : []),
        ],
      });
    }
    for (const name of query.tag) and.push({ tags: { some: { tag: { name } } } });
    if (query.consent) and.push({ consentStatus: query.consent });
    if (query.leadSource) and.push({ leadSourceKind: query.leadSource });
    const where: Prisma.ContactWhereInput = and.length ? { AND: and } : {};
    const [items, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        include: WITH_TAGS,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { items: items.map(toContactDto), page: pageMeta(query, total) };
  }

  /** Feature 010 (FR-007): the list within a saved segment, with the same other filters, in SQL. */
  private async listInSegment(query: ContactListQuery, segmentId: string) {
    const where = Prisma.sql`(${await this.segments.whereFor(segmentId)}) AND (${contactFilterSql(query)})`;
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM contacts c WHERE ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      this.prisma.$queryRaw<Array<{ total: bigint }>>`SELECT count(*) AS total FROM contacts c WHERE ${where}`,
    ]);
    const found = await this.prisma.contact.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: WITH_TAGS });
    const byId = new Map(found.map((c) => [c.id, c]));
    const items = rows.map((r) => byId.get(r.id)).filter((c): c is NonNullable<typeof c> => c !== undefined);
    return { items: items.map(toContactDto), page: pageMeta(query, Number(counted[0]?.total ?? 0)) };
  }

  /** `source` is what webhook events report; 'api' also raises the drips' API_CREATED starting event (005). */
  async create(input: ContactInput & { phone: string }, actorUserId: string | null, source: 'dashboard' | 'api' | 'store' = 'dashboard') {
    const phone = await this.normalise(input.phone);
    const attributes = await this.checkAttributes(input.attributes ?? {}, false);
    this.requireNoteForOptIn(input);
    const status = input.consentStatus && input.consentStatus !== 'UNKNOWN' ? input.consentStatus : null;
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const contact = await tx.contact.create({
          data: {
            phoneE164: phone.e164,
            countryCode: phone.country,
            name: input.name ?? null,
            attributes: attributes as Prisma.InputJsonValue,
            // Feature 010 (FR-011): API and store contacts, or added by hand in the dashboard (a custom label).
            ...leadSourceFor(LEAD_KIND[source], input.leadSourceLabel ?? (source === 'dashboard' ? 'Added by hand' : null)),
            ...(status ? { consentStatus: status, consentSource: 'MANUAL' as const, consentSourceNote: input.consentSourceNote ?? null, consentAt: now } : {}),
          },
        });
        // Automatic tags for new contacts (feature 010, R4).
        await this.autoTags.apply(tx, 'CONTACT_CREATED', contact.id, LEAD_KIND[source]);
        if (status) {
          await tx.consentEvent.create({
            data: { contactId: contact.id, status, source: 'MANUAL', note: input.consentSourceNote ?? null, actorUserId, createdAt: now },
          });
          if (status === 'OPTED_IN') await this.dripEvents.recordOptIns(tx, [contact.id]);
        }
        // Outbound webhooks (feature 006, FR-002): created first, then its consent and tags.
        await this.platformEvents.contactCreated(tx, contact.id, source, { attributes });
        if (source === 'api') await this.dripEvents.recordCreated(tx, 'API_CREATED', [contact.id]);
        if (status === 'OPTED_IN') await this.platformEvents.optedIn(tx, contact.id, 'MANUAL', input.consentSourceNote ?? null);
        if (status === 'OPTED_OUT') await this.platformEvents.optedOut(tx, contact.id, 'MANUAL');
        if (input.tags?.length) await this.setTags(tx, contact.id, input.tags);
        return contact.id;
      });
      return toContactDto(await this.prisma.contact.findUniqueOrThrow({ where: { id }, include: WITH_TAGS }));
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A contact with this phone number already exists');
      throw error;
    }
  }

  async update(id: string, input: ContactInput, actorUserId: string | null) {
    const current = await this.prisma.contact.findUnique({ where: { id } });
    if (!current) throw AppError.notFound('Contact not found');
    const phone = input.phone !== undefined ? await this.normalise(input.phone) : null;
    const changes = input.attributes ? await this.checkAttributes(input.attributes, true) : null;
    if (input.consentStatus && input.consentStatus !== current.consentStatus) this.requireNoteForOptIn(input);

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.ContactUpdateInput = {};
        if (phone) Object.assign(data, { phoneE164: phone.e164, countryCode: phone.country });
        if (input.name !== undefined) data.name = input.name;
        if (changes) {
          const merged = { ...((current.attributes ?? {}) as Record<string, unknown>) };
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
          }
          data.attributes = merged as Prisma.InputJsonValue;
        }
        if (Object.keys(data).length) await tx.contact.update({ where: { id }, data });
        await this.platformEvents.contactUpdated(tx, id, [
          ...(phone ? ['phone'] : []),
          ...(input.name !== undefined ? ['name'] : []),
          ...Object.keys(changes ?? {}).map((key) => `attributes.${key}`),
        ]);
        if (input.tags) await this.setTags(tx, id, input.tags);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A contact with this phone number already exists');
      throw error;
    }
    if (input.consentStatus && input.consentStatus !== current.consentStatus) {
      await this.consent.setStatus(id, input.consentStatus, 'MANUAL', { note: input.consentSourceNote ?? null, actorUserId });
    }
    return toContactDto(await this.prisma.contact.findUniqueOrThrow({ where: { id }, include: WITH_TAGS }));
  }

  /**
   * Feature 010 (research R3): adds or removes tags on a batch of contacts for a bulk action, with the
   * 005 drip events and the 006 webhook events of the 001 bulk route. Returns the links changed.
   */
  async tagMany(contactIds: string[], tagIds: string[], add: boolean): Promise<number> {
    if (!contactIds.length || !tagIds.length) return 0;
    if (add) {
      // Feature 010 bulk actions send 5,000 contacts at a time; the drip and webhook hooks may write a row per
      // contact, so each transaction takes 1,000 of them.
      let added = 0;
      for (let i = 0; i < contactIds.length; i += TAG_MANY_CHUNK) {
        const chunk = contactIds.slice(i, i + TAG_MANY_CHUNK);
        added += await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.contact.findMany({ where: { id: { in: chunk } }, select: { id: true } });
            const links = await tx.contactTag.createManyAndReturn({
              data: existing.flatMap((c) => tagIds.map((tagId) => ({ contactId: c.id, tagId }))),
              skipDuplicates: true,
              select: { contactId: true, tagId: true },
            });
            await this.dripEvents.recordTagAddedToMany(tx, links);
            await this.platformEvents.tagLinksChanged(tx, links);
            return links.length;
          },
          { maxWait: 10_000, timeout: 120_000 },
        );
      }
      return added;
    }
    const removed = (await this.platformEvents.listens('contact.tags_changed'))
      ? await this.prisma.contactTag.findMany({ where: { tagId: { in: tagIds }, contactId: { in: contactIds } }, select: { contactId: true, tagId: true } })
      : [];
    const { count } = await this.prisma.contactTag.deleteMany({ where: { tagId: { in: tagIds }, contactId: { in: contactIds } } });
    await this.platformEvents.tagLinksChanged(this.prisma, [], removed);
    return count;
  }

  /** POST /contacts/bulk: returns how many contacts changed. */
  async bulk(input: BulkAction): Promise<{ updated: number }> {
    const existing = await this.prisma.contact.findMany({ where: { id: { in: input.contactIds } }, select: { id: true } });
    const ids = existing.map((c) => c.id);
    if (!ids.length) return { updated: 0 };

    if (input.action === 'ADD_TAG' || input.action === 'REMOVE_TAG') {
      const name = normaliseTag(input.tag ?? '');
      if (input.action === 'ADD_TAG') {
        const tag = await this.prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
        const added = await this.prisma.$transaction(async (tx) => {
          const links = await tx.contactTag.createManyAndReturn({ data: ids.map((contactId) => ({ contactId, tagId: tag.id })), skipDuplicates: true, select: { contactId: true, tagId: true } });
          await this.dripEvents.recordTagAddedToMany(tx, links);
          await this.platformEvents.tagLinksChanged(tx, links);
          return links.length;
        });
        return { updated: added };
      }
      const tag = await this.prisma.tag.findUnique({ where: { name } });
      if (!tag) return { updated: 0 };
      const removed = (await this.platformEvents.listens('contact.tags_changed'))
        ? await this.prisma.contactTag.findMany({ where: { tagId: tag.id, contactId: { in: ids } }, select: { contactId: true, tagId: true } })
        : [];
      const { count } = await this.prisma.contactTag.deleteMany({ where: { tagId: tag.id, contactId: { in: ids } } });
      await this.platformEvents.tagLinksChanged(this.prisma, [], removed);
      return { updated: count };
    }

    const key = input.attributeKey as string;
    const [value] = Object.values(await this.checkAttributes({ [key]: input.attributeValue ?? null }, true));
    const idList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const updated =
      value === null || value === undefined
        ? await this.prisma.$executeRaw`UPDATE contacts SET attributes = attributes - ${key}, updated_at = now() WHERE id IN (${idList}) AND (attributes -> ${key}) IS NOT NULL`
        : await this.prisma.$executeRaw`UPDATE contacts SET attributes = jsonb_set(attributes, ARRAY[${key}]::text[], ${JSON.stringify(value)}::jsonb, true), updated_at = now() WHERE id IN (${idList})`;
    if (updated) await this.platformEvents.contactsUpdated(this.prisma, ids, [`attributes.${key}`]);
    return { updated };
  }

  audiencePreview(input: AudiencePreviewInput) {
    return this.audience.preview({ type: 'FILTER', filter: input.filter ?? { all: [] } }, input.templateCategory ?? 'UTILITY');
  }
}
