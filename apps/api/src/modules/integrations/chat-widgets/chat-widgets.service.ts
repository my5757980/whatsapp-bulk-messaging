import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LINK_CODE_ALPHABET, chatLinkUrl, dayInZone, makeChatRef, makeLinkCode, reportRangeBounds } from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import { SettingsService } from '../../settings/settings.service.js';

// Feature 009 (research R15, FR-039 - FR-044, contracts/website-button.md): website chat buttons. Each
// button owns 006 chat links (source WIDGET): one for its default message and one per page rule with its
// own message, so chats are counted per button and rule and the links' tag and flow apply.

const LookSchema = z
  .object({
    colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'use a colour like #25D366'),
    buttonText: z.string().trim().max(30),
    corner: z.enum(['BOTTOM_LEFT', 'BOTTOM_RIGHT']),
    offsetX: z.number().int().min(0).max(200),
    offsetY: z.number().int().min(0).max(200),
    radius: z.number().int().min(0).max(40),
  })
  .strict();

const RuleSchema = z
  .object({
    id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    match: z.enum(['EXACT', 'PREFIX', 'CONTAINS']),
    value: z.string().trim().min(1).max(200),
    hide: z.boolean(),
    greeting: z.string().trim().max(300).nullish(),
    message: z.string().trim().max(500).nullish(),
  })
  .strict();

export const ChatWidgetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    numberId: z.uuid(),
    look: LookSchema,
    brandName: z.string().trim().max(60),
    brandImageAssetId: z.uuid().nullish(),
    greeting: z.string().trim().max(300),
    message: z.string().trim().min(1).max(500),
    rules: z.array(RuleSchema).max(50),
  })
  .strict();
export type ChatWidgetInput = z.infer<typeof ChatWidgetInputSchema>;

export const ChatWidgetStatsQuerySchema = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).strict();

export interface StoredRule {
  id: string;
  match: 'EXACT' | 'PREFIX' | 'CONTAINS';
  value: string;
  hide: boolean;
  greeting: string | null;
  message: string | null;
}

const KEY_LENGTH = 12;
const NAME_TAKEN = () => AppError.conflict('Another website button has this name', 'NAME_TAKEN');
const INCLUDE = { number: { select: { label: true, connectionStatus: true } } } as const satisfies Prisma.ChatWidgetInclude;
type Row = Prisma.ChatWidgetGetPayload<{ include: typeof INCLUDE }>;
type Tx = Prisma.TransactionClient;

const makeKey = () => Array.from({ length: KEY_LENGTH }, () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]).join('');
const makeRuleId = () => `r${Array.from({ length: 8 }, () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]).join('')}`;

@Injectable()
export class ChatWidgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list() {
    const rows = await this.prisma.chatWidget.findMany({ include: INCLUDE, orderBy: { createdAt: 'desc' } });
    const counts = await this.last30Days(rows.map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, counts.get(r.id))) };
  }

  async get(id: string) {
    const row = await this.load(id);
    return this.toDto(row, (await this.last30Days([id])).get(id));
  }

  async create(input: ChatWidgetInput, actor: AuditActor & { userId: string }) {
    this.base();
    await this.checked(input);
    if (await this.prisma.chatWidget.findFirst({ where: { name: input.name }, select: { id: true } })) throw NAME_TAKEN();
    const rules = normaliseRules(input.rules);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const id = await this.prisma.$transaction(async (tx) => {
          const widget = await tx.chatWidget.create({
            data: { key: makeKey(), name: input.name, numberId: input.numberId, look: input.look, brandName: input.brandName, brandImageAssetId: input.brandImageAssetId ?? null, greeting: input.greeting, message: input.message, rules: rules as unknown as Prisma.InputJsonValue, createdById: actor.userId },
          });
          await this.syncLinks(tx, widget.id, widget.key, input.numberId, input.message, rules, actor.userId);
          return widget.id;
        });
        await this.audit.record(actor, 'chat_widget.created', { type: 'chat_widget', id }, { name: input.name, rules: rules.length });
        return this.get(id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (await this.prisma.chatWidget.findFirst({ where: { name: input.name }, select: { id: true } })) throw NAME_TAKEN();
        if (attempt >= 5) throw error;
      }
    }
  }

  /** The key, and so the snippet, never change (FR-042). */
  async update(id: string, input: ChatWidgetInput, actor: AuditActor & { userId: string }) {
    const current = await this.load(id);
    await this.checked(input);
    if (await this.prisma.chatWidget.findFirst({ where: { name: input.name, id: { not: id } }, select: { id: true } })) throw NAME_TAKEN();
    const keptIds = new Set(((current.rules ?? []) as unknown as StoredRule[]).map((r) => r.id));
    const rules = normaliseRules(input.rules, keptIds);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.chatWidget.update({
          where: { id },
          data: { name: input.name, numberId: input.numberId, look: input.look, brandName: input.brandName, brandImageAssetId: input.brandImageAssetId ?? null, greeting: input.greeting, message: input.message, rules: rules as unknown as Prisma.InputJsonValue },
        });
        await this.syncLinks(tx, id, current.key, input.numberId, input.message, rules, actor.userId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw NAME_TAKEN();
      throw error;
    }
    await this.audit.record(actor, 'chat_widget.updated', { type: 'chat_widget', id }, { name: input.name, rules: rules.length });
    return this.get(id);
  }

  async setStatus(id: string, status: 'ACTIVE' | 'PAUSED', actor: AuditActor) {
    const current = await this.load(id);
    if (status === 'ACTIVE' && current.number.connectionStatus !== 'CONNECTED') throw AppError.conflict('Connect the button\'s number before showing it again', 'NUMBER_NOT_CONNECTED');
    await this.prisma.chatWidget.update({ where: { id }, data: { status } });
    await this.audit.record(actor, 'chat_widget.updated', { type: 'chat_widget', id }, { status });
    return this.get(id);
  }

  /** The snippet then shows nothing and the button's chat links stop. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const current = await this.load(id);
    await this.prisma.chatWidget.delete({ where: { id } });
    await this.audit.record(actor, 'chat_widget.deleted', { type: 'chat_widget', id }, { name: current.name });
  }

  /** Opens by page and chats started by rule in the company time zone (FR-043). */
  async stats(id: string, query: { from?: string | undefined; to?: string | undefined }) {
    const widget = await this.load(id);
    const { defaultTimezone: tz } = await this.settings.get();
    const to = query.to ?? dayInZone(new Date(), tz);
    const from = query.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw AppError.validation('The first day is after the last day', [{ field: 'from', issue: 'must not be after to' }]);
    const { start, end } = reportRangeBounds(from, to, tz);
    const opens = await this.prisma.$queryRaw<Array<{ page: string; opens: number }>>`
      SELECT COALESCE(o.page, '(not known)') AS page, COUNT(*)::int AS opens
        FROM chat_link_opens o JOIN chat_links l ON l.id = o.chat_link_id
       WHERE l.widget_id = ${id}::uuid AND o.opened_at >= ${start} AND o.opened_at < ${end}
       GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`;
    const starts = await this.prisma.$queryRaw<Array<{ rule_id: string | null; chats: number; fresh: number }>>`
      SELECT l.widget_rule_id AS rule_id, COUNT(*)::int AS chats, COUNT(*) FILTER (WHERE s.new_contact)::int AS fresh
        FROM chat_link_starts s JOIN chat_links l ON l.id = s.chat_link_id
       WHERE l.widget_id = ${id}::uuid AND s.started_at >= ${start} AND s.started_at < ${end}
       GROUP BY 1`;
    const rules = (widget.rules ?? []) as unknown as StoredRule[];
    return {
      from,
      to,
      opensByPage: opens,
      chatsByRule: starts.map((s) => ({ ruleId: s.rule_id, label: ruleLabel(rules, s.rule_id), chatsStarted: s.chats, newContacts: s.fresh })),
    };
  }

  /** The public config of a key: null for an unknown key, else the body and its version (ETag). */
  async publicConfig(key: string): Promise<{ version: string; body: Record<string, unknown> } | null> {
    const widget = await this.prisma.chatWidget.findUnique({
      where: { key },
      include: { number: { select: { connectionStatus: true } }, links: { where: { deletedAt: null, status: 'ACTIVE' }, select: { code: true, widgetRuleId: true } } },
    });
    if (!widget) return null;
    const version = widget.updatedAt.getTime().toString(36);
    const base = this.config.PUBLIC_LINK_BASE_URL;
    const link = (ruleId: string | null) => widget.links.find((l) => l.widgetRuleId === ruleId);
    const defaultLink = link(null);
    if (widget.status !== 'ACTIVE' || widget.number.connectionStatus !== 'CONNECTED' || !base || !defaultLink) return { version: `${version}-hidden`, body: { hidden: true } };
    const rules = (widget.rules ?? []) as unknown as StoredRule[];
    return {
      version,
      body: {
        hidden: false,
        version,
        look: widget.look,
        brandName: widget.brandName,
        brandImageUrl: widget.brandImageAssetId ? `${base.replace(/\/+$/, '')}/w/${key}/image?v=${version}` : null,
        greeting: widget.greeting,
        startUrl: chatLinkUrl(base, defaultLink.code),
        rules: rules.map((r) => {
          const own = link(r.id);
          return { id: r.id, match: r.match, value: r.value, hide: r.hide, greeting: r.greeting, startUrl: own ? chatLinkUrl(base, own.code) : null };
        }),
      },
    };
  }

  /** The brand image of a key, or null. */
  async image(key: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
    const widget = await this.prisma.chatWidget.findUnique({ where: { key }, select: { brandImageAsset: { select: { storageKey: true, mimeType: true } } } });
    const asset = widget?.brandImageAsset;
    if (!asset) return null;
    return { mimeType: asset.mimeType, bytes: await this.storage.getBuffer(asset.storageKey) };
  }

  /** The snippet lives on the 005 public link address. */
  private base(): string {
    const base = this.config.PUBLIC_LINK_BASE_URL;
    if (!base) throw AppError.validation('Website buttons need the public link address (PUBLIC_LINK_BASE_URL) on the server', [], 'LINKS_NOT_SET_UP');
    return base.replace(/\/+$/, '');
  }

  private async checked(input: ChatWidgetInput): Promise<void> {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { connectionStatus: true } });
    if (!number) throw AppError.validation('Choose a WhatsApp number', [{ field: 'numberId', issue: 'not found' }]);
    if (number.connectionStatus !== 'CONNECTED') throw AppError.validation('The number is not connected', [{ field: 'numberId', issue: 'connect the number first' }], 'NUMBER_NOT_CONNECTED');
    if (input.brandImageAssetId && !(await this.prisma.mediaAsset.findUnique({ where: { id: input.brandImageAssetId }, select: { id: true } }))) {
      throw AppError.validation('The brand image was not found', [{ field: 'brandImageAssetId', issue: 'upload it again' }]);
    }
  }

  private async load(id: string): Promise<Row> {
    const row = await this.prisma.chatWidget.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw AppError.notFound('Website button not found');
    return row;
  }

  /** The default link and one link per rule with its own message; links of removed messages stop. */
  private async syncLinks(tx: Tx, widgetId: string, key: string, numberId: string, message: string, rules: StoredRule[], userId: string): Promise<void> {
    const existing = await tx.chatLink.findMany({ where: { widgetId, deletedAt: null }, select: { id: true, widgetRuleId: true, message: true, numberId: true } });
    const wanted = [{ ruleId: null as string | null, message }, ...rules.filter((r) => !r.hide && r.message).map((r) => ({ ruleId: r.id as string | null, message: r.message! }))];
    for (const want of wanted) {
      const link = existing.find((l) => l.widgetRuleId === want.ruleId);
      if (link) {
        if (link.message !== want.message || link.numberId !== numberId) await tx.chatLink.update({ where: { id: link.id }, data: { message: want.message, numberId } });
        continue;
      }
      await tx.chatLink.create({
        data: {
          name: `Website button ${key}${want.ruleId ? ` · ${want.ruleId}` : ''}`,
          numberId,
          message: want.message,
          ref: makeChatRef(randomInt),
          code: makeLinkCode(randomInt),
          source: 'WIDGET',
          widgetId,
          widgetRuleId: want.ruleId,
          createdById: userId,
        },
      });
    }
    const stale = existing.filter((l) => !wanted.some((w) => w.ruleId === l.widgetRuleId)).map((l) => l.id);
    if (stale.length) await tx.chatLink.updateMany({ where: { id: { in: stale } }, data: { deletedAt: new Date() } });
  }

  private async last30Days(ids: string[]): Promise<Map<string, { opens: number; chatsStarted: number }>> {
    if (!ids.length) return new Map();
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ widget_id: string; opens: number; starts: number }>>`
      SELECT l.widget_id::text AS widget_id,
             (SELECT COUNT(*) FROM chat_link_opens o WHERE o.chat_link_id = ANY(array_agg(l.id)) AND o.opened_at >= ${since})::int AS opens,
             (SELECT COUNT(*) FROM chat_link_starts s WHERE s.chat_link_id = ANY(array_agg(l.id)) AND s.started_at >= ${since})::int AS starts
        FROM chat_links l
       WHERE l.widget_id = ANY(${ids}::uuid[])
       GROUP BY l.widget_id`;
    return new Map(rows.map((r) => [r.widget_id, { opens: r.opens, chatsStarted: r.starts }]));
  }

  private toDto(row: Row, counts: { opens: number; chatsStarted: number } | undefined) {
    const base = this.config.PUBLIC_LINK_BASE_URL?.replace(/\/+$/, '') ?? '';
    const rules = ((row.rules ?? []) as unknown as StoredRule[]).map((r) => ({ id: r.id, match: r.match, value: r.value, hide: r.hide, greeting: r.greeting, message: r.message }));
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      numberId: row.numberId,
      numberLabel: row.number.label,
      look: row.look,
      brandName: row.brandName,
      brandImageAssetId: row.brandImageAssetId,
      greeting: row.greeting,
      message: row.message,
      rules,
      status: row.status,
      snippet: `<script async src="${base}/w/widget.js" data-key="${row.key}"></script>`,
      numberConnected: row.number.connectionStatus === 'CONNECTED',
      last30Days: counts ?? { opens: 0, chatsStarted: 0 },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Rule values are matched in lower case; new rules get an id, existing ids are kept. */
function normaliseRules(rules: ChatWidgetInput['rules'], keep: ReadonlySet<string> = new Set()): StoredRule[] {
  const seen = new Set<string>();
  return rules.map((r) => {
    let id = r.id && (keep.has(r.id) || /^r[A-Za-z0-9]{8}$/.test(r.id)) && !seen.has(r.id) ? r.id : makeRuleId();
    while (seen.has(id)) id = makeRuleId();
    seen.add(id);
    return { id, match: r.match, value: r.value.toLowerCase(), hide: r.hide, greeting: r.greeting?.trim() || null, message: r.hide ? null : r.message?.trim() || null };
  });
}

/** "Default", the rule's match and value, or a removed rule. */
export function ruleLabel(rules: readonly StoredRule[], ruleId: string | null): string {
  if (!ruleId) return 'Default';
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return 'Removed rule';
  return `${rule.match === 'EXACT' ? 'Page' : rule.match === 'PREFIX' ? 'Pages starting with' : 'Pages containing'} ${rule.value}`;
}
