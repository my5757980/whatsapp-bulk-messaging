import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CHAT_LINK_MESSAGE_MAX, chatLinkUrl, makeChatRef, makeLinkCode, messageWithRef, waMeUrl } from '@wbm/shared';
import QRCode from 'qrcode';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PageQuery } from '../../../common/validation/pagination.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { normaliseTag } from '../../contacts/tags.controller.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { SettingsService } from '../../settings/settings.service.js';
import { PlatformEvents } from '../webhooks/platform-events.js';

// Chat links and QR codes in the dashboard (feature 006 US7, FR-045 - FR-050, research R12,
// contracts/integrations-api.openapi.yaml tag chat-links): links with a short address and a
// reference made once, QR images, results per day, and the contacts who started chats.

const fields = {
  name: z.string().trim().min(1).max(80),
  numberId: z.uuid(),
  message: z.string().trim().min(1).max(CHAT_LINK_MESSAGE_MAX),
  flowId: z.uuid().nullable(),
  tagId: z.uuid().nullable(),
  status: z.enum(['ACTIVE', 'OFF']),
};

export const ChatLinkCreateSchema = z
  .object({ name: fields.name, numberId: fields.numberId, message: fields.message, flowId: fields.flowId.optional(), tagId: fields.tagId.optional() })
  .strict();
export type ChatLinkCreate = z.infer<typeof ChatLinkCreateSchema>;

/** The number, the short link and the reference never change (the printed codes keep working). */
export const ChatLinkPatchSchema = z
  .object({ name: fields.name, message: fields.message, flowId: fields.flowId, tagId: fields.tagId, status: fields.status })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field' });
export type ChatLinkPatch = z.infer<typeof ChatLinkPatchSchema>;

export const QrQuerySchema = z
  .object({ format: z.enum(['svg', 'png']).default('svg'), size: z.coerce.number().int().min(128).max(2048).default(1024) })
  .strict();
export type QrQuery = z.infer<typeof QrQuerySchema>;

export const ChatLinkResultsQuerySchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to', path: ['from'] });
export type ChatLinkResultsQuery = z.infer<typeof ChatLinkResultsQuerySchema>;

export const TagContactsSchema = z.object({ tag: z.string().trim().min(1).max(50) }).strict();

const INCLUDE = {
  number: { select: { label: true, displayPhoneNumber: true } },
  flow: { select: { name: true } },
  tag: { select: { name: true } },
  _count: { select: { opens: true, starts: true } },
} as const satisfies Prisma.ChatLinkInclude;
type Row = Prisma.ChatLinkGetPayload<{ include: typeof INCLUDE }>;

export interface ChatLinkContactRow {
  id: string;
  name: string | null;
  phone: string;
  firstStartedAt: Date;
  lastStartedAt: Date;
  starts: number;
}

const NAME_TAKEN = () => AppError.conflict('Another chat link has this name', 'NAME_TAKEN');
const EXPORT_PAGE = 1000;

@Injectable()
export class ChatLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list() {
    // Feature 009: website button links (source WIDGET) are managed with their button.
    const rows = await this.prisma.chatLink.findMany({ where: { deletedAt: null, source: 'MANUAL' }, include: INCLUDE, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string) {
    return this.toDto(await this.load(id));
  }

  async create(input: ChatLinkCreate, actor: AuditActor & { userId: string }) {
    this.baseUrl();
    await this.checked(input.numberId, input.flowId ?? null, input.tagId ?? null);
    if (await this.nameTaken(input.name, null)) throw NAME_TAKEN();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const created = await this.prisma.chatLink.create({
          data: {
            name: input.name,
            numberId: input.numberId,
            message: input.message,
            ref: makeChatRef(randomInt),
            code: makeLinkCode(randomInt),
            flowId: input.flowId ?? null,
            tagId: input.tagId ?? null,
            createdById: actor.userId,
          },
          include: INCLUDE,
        });
        await this.audit.record(actor, 'chat_link.created', { type: 'chat_link', id: created.id }, { name: created.name, numberId: created.numberId });
        return this.toDto(created);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Another link took the name meanwhile, or a new code or reference was already used: try new ones.
        if (await this.nameTaken(input.name, null)) throw NAME_TAKEN();
        if (attempt >= 5) throw error;
      }
    }
  }

  async update(id: string, input: ChatLinkPatch, actor: AuditActor) {
    const current = await this.load(id);
    await this.checked(current.numberId, input.flowId === undefined ? undefined : input.flowId, input.tagId === undefined ? undefined : input.tagId);
    if (input.name !== undefined && (await this.nameTaken(input.name, id))) throw NAME_TAKEN();
    try {
      const updated = await this.prisma.chatLink.update({ where: { id }, data: input, include: INCLUDE });
      const turnedOff = input.status === 'OFF' && current.status === 'ACTIVE';
      await this.audit.record(actor, turnedOff ? 'chat_link.turned_off' : 'chat_link.updated', { type: 'chat_link', id }, { changed: Object.keys(input) });
      return this.toDto(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw NAME_TAKEN();
      throw error;
    }
  }

  /** The link then shows "no longer in use" (FR-050); its openings and chat starts stay. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.load(id);
    await this.prisma.chatLink.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.record(actor, 'chat_link.deleted', { type: 'chat_link', id }, { name: row.name });
  }

  /** The QR code of the short link, so every scan is counted (FR-046, FR-047). */
  async qr(id: string, query: QrQuery): Promise<{ contentType: string; body: string | Buffer; filename: string }> {
    const row = await this.load(id);
    const url = chatLinkUrl(this.baseUrl(), row.code);
    const filename = `chat-link-${slug(row.name)}.${query.format}`;
    const options = { width: query.size, margin: 2, errorCorrectionLevel: 'M' as const };
    if (query.format === 'png') return { contentType: 'image/png', body: await QRCode.toBuffer(url, { ...options, type: 'png' }), filename };
    return { contentType: 'image/svg+xml', body: await QRCode.toString(url, { ...options, type: 'svg' }), filename };
  }

  /** Opens, chats started and new contacts per day in the company time zone (FR-049). */
  async results(id: string, query: ChatLinkResultsQuery) {
    await this.load(id);
    const { defaultTimezone: tz } = await this.settings.get();
    const to = query.to ?? localDate(new Date(), tz);
    const from = query.from ?? addDays(to, -29);
    const start = Prisma.sql`(${from}::date::timestamp AT TIME ZONE ${tz})`;
    const end = Prisma.sql`((${to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    const days = await this.prisma.$queryRaw<Array<{ date: string; opens: number; chatsStarted: number; newContacts: number }>>`
      SELECT to_char(day, 'YYYY-MM-DD') AS date, sum(opens)::int AS opens, sum(starts)::int AS "chatsStarted", sum(fresh)::int AS "newContacts"
        FROM (
          SELECT (opened_at AT TIME ZONE ${tz})::date AS day, count(*) AS opens, 0::bigint AS starts, 0::bigint AS fresh
            FROM chat_link_opens
           WHERE chat_link_id = ${id}::uuid AND opened_at >= ${start} AND opened_at < ${end}
           GROUP BY 1
          UNION ALL
          SELECT (started_at AT TIME ZONE ${tz})::date, 0::bigint, count(*), count(*) FILTER (WHERE new_contact)
            FROM chat_link_starts
           WHERE chat_link_id = ${id}::uuid AND started_at >= ${start} AND started_at < ${end}
           GROUP BY 1
        ) counts
       GROUP BY day
       ORDER BY day`;
    const totals = { opens: 0, chatsStarted: 0, newContacts: 0 };
    for (const day of days) {
      totals.opens += day.opens;
      totals.chatsStarted += day.chatsStarted;
      totals.newContacts += day.newContacts;
    }
    return { from, to, totals, days };
  }

  /** The contacts who started chats, newest first; phones masked without phones.full. */
  async contacts(id: string, query: PageQuery, fullPhones: boolean) {
    await this.load(id);
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string | null; phone: string; startedAt: Date }>>`
        SELECT c.id, c.name, c.phone_e164 AS phone, max(s.started_at) AS "startedAt"
          FROM chat_link_starts s
          JOIN contacts c ON c.id = s.contact_id
         WHERE s.chat_link_id = ${id}::uuid
         GROUP BY c.id
         ORDER BY max(s.started_at) DESC, c.id
         LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT count(DISTINCT contact_id)::int AS total FROM chat_link_starts WHERE chat_link_id = ${id}::uuid`,
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, name: r.name, phone: fullPhones ? r.phone : maskPhone(r.phone), startedAt: r.startedAt.toISOString() })),
      total: counted[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** The same contacts for the CSV export, in pages by contact id. */
  async *exportRows(id: string): AsyncGenerator<ChatLinkContactRow[]> {
    let after: string | null = null;
    for (;;) {
      const rows: ChatLinkContactRow[] = await this.prisma.$queryRaw<ChatLinkContactRow[]>`
        SELECT c.id, c.name, c.phone_e164 AS phone, min(s.started_at) AS "firstStartedAt", max(s.started_at) AS "lastStartedAt", count(*)::int AS starts
          FROM chat_link_starts s
          JOIN contacts c ON c.id = s.contact_id
         WHERE s.chat_link_id = ${id}::uuid ${after ? Prisma.sql`AND c.id > ${after}::uuid` : Prisma.empty}
         GROUP BY c.id
         ORDER BY c.id
         LIMIT ${EXPORT_PAGE}`;
      if (rows.length) yield rows;
      if (rows.length < EXPORT_PAGE) return;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** Adds a tag to every contact who started a chat, for a campaign audience (FR-049). */
  async tagContacts(id: string, tagName: string, actor: AuditActor): Promise<{ tagged: number }> {
    await this.load(id);
    const name = normaliseTag(tagName);
    const tag = await this.prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
    const tagged = await this.prisma.$transaction(async (tx) => {
      const contacts = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT contact_id AS id FROM chat_link_starts WHERE chat_link_id = ${id}::uuid AND contact_id IS NOT NULL`;
      if (!contacts.length) return 0;
      const links = await tx.contactTag.createManyAndReturn({ data: contacts.map((c) => ({ contactId: c.id, tagId: tag.id })), skipDuplicates: true, select: { contactId: true, tagId: true } });
      // Tags added here can start drips and reach webhook endpoints, as with the contacts bulk action.
      await this.dripEvents.recordTagAddedToMany(tx, links);
      await this.platformEvents.tagLinksChanged(tx, links);
      return links.length;
    });
    await this.audit.record(actor, 'chat_link.contacts_tagged', { type: 'chat_link', id }, { tag: name, tagged });
    return { tagged };
  }

  async assertExists(id: string): Promise<{ name: string }> {
    return this.load(id);
  }

  private async load(id: string): Promise<Row> {
    const row = await this.prisma.chatLink.findFirst({ where: { id, deletedAt: null, source: 'MANUAL' }, include: INCLUDE });
    if (!row) throw AppError.notFound('Chat link not found');
    return row;
  }

  /** The flow must be published and run on the link's number (FR-045); undefined leaves a field as it is. */
  private async checked(numberId: string, flowId: string | null | undefined, tagId: string | null | undefined): Promise<void> {
    const details: Array<{ field: string; issue: string }> = [];
    if (!(await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { id: true } }))) {
      details.push({ field: 'numberId', issue: 'is not a WhatsApp number of the company' });
    }
    if (flowId) {
      const flow = await this.prisma.flow.findUnique({
        where: { id: flowId },
        select: { status: true, deletedAt: true, publishedVersionId: true, allNumbers: true, numbers: { where: { numberId }, select: { numberId: true } } },
      });
      if (!flow || flow.deletedAt) details.push({ field: 'flowId', issue: 'is not a flow' });
      else if (flow.status !== 'PUBLISHED' || !flow.publishedVersionId) details.push({ field: 'flowId', issue: 'is not published' });
      else if (!flow.allNumbers && !flow.numbers.length) details.push({ field: 'flowId', issue: "does not run on the link's number" });
    }
    if (tagId && !(await this.prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } }))) details.push({ field: 'tagId', issue: 'is not a tag' });
    if (details.length) throw AppError.validation('Check the chat link settings', details);
  }

  private async nameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const taken = await this.prisma.chatLink.findFirst({ where: { name, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    return taken !== null;
  }

  /** Chat links live on the 005 public link address; without it there is no short link to print. */
  private baseUrl(): string {
    const base = this.config.PUBLIC_LINK_BASE_URL;
    if (!base) throw AppError.validation('Chat links need the public link address (PUBLIC_LINK_BASE_URL) on the server', [], 'LINKS_NOT_SET_UP');
    return base;
  }

  private toDto(row: Row) {
    const base = this.config.PUBLIC_LINK_BASE_URL;
    return {
      id: row.id,
      name: row.name,
      numberId: row.numberId,
      numberLabel: row.number.label,
      message: row.message,
      ref: row.ref,
      shortUrl: base ? chatLinkUrl(base, row.code) : '',
      whatsappUrl: waMeUrl(row.number.displayPhoneNumber, messageWithRef(row.message, row.ref)),
      flowId: row.flowId,
      flowName: row.flow?.name ?? null,
      tagId: row.tagId,
      tagName: row.tag?.name ?? null,
      status: row.status,
      opens: row._count.opens,
      chatsStarted: row._count.starts,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'link'
  );
}

/** YYYY-MM-DD of an instant in a time zone. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
