import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ConsentService } from '../contacts/consent.service.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { normaliseTag } from '../contacts/tags.controller.js';
import { JourneyService } from '../inbox/journey/journey.service.js';
import { InboxPublisher } from '../inbox/realtime/inbox-publisher.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ApiKeyContext } from './api-key.guard.js';
import type { Answer } from './idempotent-responses.service.js';

// Contacts through the public API (feature 006 US2, FR-011 - FR-016, contracts/public-api-v1.openapi.yaml).
// Writes go through the dashboard services, so attribute types, tag names, consent rules, drip
// starting events and webhook events are the same; journey entries name the API key.

const optInSchema = z.object({ sourceNote: z.string().trim().min(3).max(500) }).strict();
const tagName = z.string().trim().min(1).max(50);

export const ContactUpsertSchema = z
  .object({
    phone: z.string().trim().min(1).max(32),
    name: z.string().trim().max(120).nullable().optional(),
    tags: z.array(tagName).max(20).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    optIn: optInSchema.optional(),
  })
  .strict();
export type ContactUpsert = z.infer<typeof ContactUpsertSchema>;

export const ContactPatchSchema = z
  .object({ name: z.string().trim().max(120).nullable().optional(), attributes: z.record(z.string(), z.unknown()).optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.attributes !== undefined, { message: 'Change the name or the attributes' });
export type ContactPatch = z.infer<typeof ContactPatchSchema>;

export const TagsInputSchema = z.object({ tags: z.array(tagName).min(1).max(20) }).strict();
export type TagsInput = z.infer<typeof TagsInputSchema>;
export const OptInSchema = optInSchema;
export type OptInInput = z.infer<typeof OptInSchema>;

export const ContactListQuerySchema = z
  .object({
    tag: z.string().trim().min(1).max(50).optional(),
    updatedSince: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;

const WITH_TAGS = { tags: { select: { tag: { select: { name: true } } } } } as const;
type ContactRow = Prisma.ContactGetPayload<{ include: typeof WITH_TAGS }>;
type JourneyType = 'TAG_ADDED' | 'TAG_REMOVED' | 'ATTRIBUTE_CHANGED' | 'CONSENT_CHANGED';

export interface PublicContactDto {
  id: string;
  phone: string;
  name: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  consentStatus: string;
  consentAt: string | null;
  blocked: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDto(c: ContactRow): PublicContactDto {
  return {
    id: c.id,
    phone: c.phoneE164,
    name: c.name,
    tags: c.tags.map((t) => t.tag.name).sort(),
    attributes: (c.attributes ?? {}) as Record<string, unknown>,
    consentStatus: c.consentStatus,
    consentAt: c.consentAt?.toISOString() ?? null,
    blocked: c.blockedAt !== null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** The list cursor: the last row's change time and id, so pages stay stable while contacts change. */
function encodeCursor(c: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([c.updatedAt.toISOString(), c.id])).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    const date = new Date(String(at));
    if (Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) throw new Error('bad cursor');
    return { at: date, id: id as string };
  } catch {
    throw AppError.validation('The cursor is not valid', [{ field: 'cursor', issue: 'use the nextCursor of the previous page' }]);
  }
}

@Injectable()
export class PublicContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly journey: JourneyService,
    private readonly publisher: InboxPublisher,
  ) {}

  async get(id: string): Promise<PublicContactDto> {
    const row = await this.prisma.contact.findUnique({ where: { id }, include: WITH_TAGS });
    if (!row) throw AppError.notFound('Contact not found');
    return toDto(row);
  }

  async lookup(phone: string): Promise<PublicContactDto> {
    const e164 = (await this.normalise(phone)).e164;
    const row = await this.prisma.contact.findUnique({ where: { phoneE164: e164 }, include: WITH_TAGS });
    if (!row) throw AppError.notFound('Contact not found');
    return toDto(row);
  }

  /** Oldest change first, so a sync can resume from its last page (FR-012). */
  async list(query: ContactListQuery): Promise<{ items: PublicContactDto[]; nextCursor: string | null }> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const and: Prisma.ContactWhereInput[] = [];
    if (query.tag) and.push({ tags: { some: { tag: { name: normaliseTag(query.tag) } } } });
    if (query.updatedSince) and.push({ updatedAt: { gte: new Date(query.updatedSince) } });
    if (after) and.push({ OR: [{ updatedAt: { gt: after.at } }, { updatedAt: after.at, id: { gt: after.id } }] });
    const rows = await this.prisma.contact.findMany({ where: { AND: and }, include: WITH_TAGS, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return { items: page.map(toDto), nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  /** Creates the contact, or updates the one with this phone number: never a duplicate (FR-011). */
  async upsert(input: ContactUpsert, key: ApiKeyContext): Promise<Answer<PublicContactDto>> {
    const phone = await this.normalise(input.phone);
    let existing = await this.prisma.contact.findUnique({ where: { phoneE164: phone.e164 }, include: WITH_TAGS });
    if (!existing) {
      let createdId: string | null = null;
      try {
        createdId = (await this.contacts.create({ phone: phone.e164, name: input.name ?? null, attributes: input.attributes ?? {}, tags: input.tags ?? [] }, null, 'api')).id;
      } catch (error) {
        // Another request created it a moment ago: update that one instead.
        if (!(error instanceof AppError) || error.status !== HttpStatus.CONFLICT) throw error;
        existing = await this.prisma.contact.findUnique({ where: { phoneE164: phone.e164 }, include: WITH_TAGS });
        if (!existing) throw error;
      }
      if (createdId) {
        if (input.optIn) await this.optIn(createdId, input.optIn.sourceNote, key);
        return { status: 201, body: await this.get(createdId) };
      }
    }
    const before = toDto(existing!);
    const added = (input.tags ?? []).map(normaliseTag).filter((t) => !before.tags.includes(t));
    await this.contacts.update(
      before.id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
        ...(added.length ? { tags: [...before.tags, ...new Set(added)] } : {}),
      },
      null,
    );
    await this.changed(key, before, await this.get(before.id));
    if (input.optIn) await this.optIn(before.id, input.optIn.sourceNote, key);
    return { status: 200, body: await this.get(before.id) };
  }

  async patch(id: string, input: ContactPatch, key: ApiKeyContext): Promise<PublicContactDto> {
    const before = await this.get(id);
    await this.contacts.update(id, { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.attributes ? { attributes: input.attributes } : {}) }, null);
    return this.changed(key, before, await this.get(id));
  }

  async addTags(id: string, tags: string[], key: ApiKeyContext): Promise<PublicContactDto> {
    const before = await this.get(id);
    const added = [...new Set(tags.map(normaliseTag).filter((t) => !before.tags.includes(t)))];
    if (!added.length) return before;
    await this.contacts.update(id, { tags: [...before.tags, ...added] }, null);
    return this.changed(key, before, await this.get(id));
  }

  async removeTag(id: string, tag: string, key: ApiKeyContext): Promise<PublicContactDto> {
    const before = await this.get(id);
    const name = normaliseTag(tag);
    if (!before.tags.includes(name)) return before;
    await this.contacts.update(id, { tags: before.tags.filter((t) => t !== name) }, null);
    return this.changed(key, before, await this.get(id));
  }

  /** An opt-in needs a source note (001 FR-012); a contact who opted out cannot be opted in by the API. */
  async optIn(id: string, sourceNote: string, key: ApiKeyContext): Promise<PublicContactDto> {
    await this.get(id);
    const change = await this.consent.setStatus(id, 'OPTED_IN', 'API', { note: sourceNote });
    if (change === 'blocked') throw AppError.conflict('This contact opted out; only they can opt in again', 'OPTED_OUT');
    if (change === 'changed') await this.notify(id, key, [['CONSENT_CHANGED', { status: 'OPTED_IN', source: 'API', note: sourceNote }]]);
    return this.get(id);
  }

  /** An opt-out always wins. */
  async optOut(id: string, key: ApiKeyContext): Promise<PublicContactDto> {
    await this.get(id);
    const change = await this.consent.setStatus(id, 'OPTED_OUT', 'API');
    if (change === 'changed') await this.notify(id, key, [['CONSENT_CHANGED', { status: 'OPTED_OUT', source: 'API' }]]);
    return this.get(id);
  }

  tags() {
    return this.prisma.tag.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  attributes() {
    return this.prisma.attributeDefinition.findMany({ select: { key: true, label: true, type: true }, orderBy: { key: 'asc' } });
  }

  /** Numbers without a country code are read with the company's default country. */
  async normalise(raw: string) {
    const { defaultCountryCode } = await this.settings.get();
    const phone = normalizePhone(raw, defaultCountryCode);
    if (!phone) throw AppError.validation('Invalid phone number', [{ field: 'phone', issue: 'is not a valid phone number' }]);
    return phone;
  }

  /** Journey entries for what changed, by the API key (FR-016), and a refresh of open chats. */
  private async changed(key: ApiKeyContext, before: PublicContactDto, after: PublicContactDto): Promise<PublicContactDto> {
    const entries: Array<[JourneyType, Record<string, unknown>]> = [];
    for (const tag of after.tags.filter((t) => !before.tags.includes(t))) entries.push(['TAG_ADDED', { tag }]);
    for (const tag of before.tags.filter((t) => !after.tags.includes(t))) entries.push(['TAG_REMOVED', { tag }]);
    for (const attr of new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)])) {
      const from = before.attributes[attr] ?? null;
      const to = after.attributes[attr] ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) entries.push(['ATTRIBUTE_CHANGED', { key: attr, from, to }]);
    }
    if (entries.length || before.name !== after.name) await this.notify(after.id, key, entries);
    return after;
  }

  private async notify(contactId: string, key: ApiKeyContext, entries: Array<[JourneyType, Record<string, unknown>]>): Promise<void> {
    let chats = 0;
    for (const [type, data] of entries) {
      chats = (await this.journey.recordForContact(contactId, { type, actorType: 'API_KEY', actorUserId: null, data: { ...data, apiKey: { id: key.id, name: key.name } } })).length;
    }
    if (!entries.length) chats = await this.prisma.conversation.count({ where: { contactId } });
    if (chats) await this.publisher.contactUpdated(contactId);
  }
}
