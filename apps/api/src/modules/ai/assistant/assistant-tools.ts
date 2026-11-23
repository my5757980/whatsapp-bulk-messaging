import { Injectable } from '@nestjs/common';
import { can, FlowGraphSchema, validateForPublish, type Permission, type Role } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone, normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { CampaignInputSchema, CampaignsService } from '../../campaigns/campaigns.service.js';
import { EstimateService } from '../../campaigns/estimate.service.js';
import { LaunchService } from '../../campaigns/launch.service.js';
import { ATTRIBUTE_OPERATORS } from '../../contacts/audience-query.builder.js';
import { normaliseTag } from '../../contacts/tags.controller.js';
import { FlowsService } from '../../flows/definitions/flows.service.js';
import { ReservedKeywords } from '../../flows/definitions/reserved-keywords.js';
import { ReportsService } from '../../reports/reports.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { TemplatesService } from '../../templates/templates.service.js';
import type { ClaudeTool } from '../claude/claude.client.js';

// The team assistant's tools (004 T101, research R14, FR-042–FR-045). Every tool acts as the member
// through the existing services and checks the member's permission first. Draft tools create drafts
// only (templates not submitted, flows not published, campaigns not scheduled); propose tools store
// a preview that runs only when the member confirms it. No tool sends, spends or deletes.

/** A preview waits this long for the member's confirmation (data-model assistant_actions). */
export const ACTION_TTL_MS = 30 * 60_000;
/** At most this many contacts in one deletion preview. */
export const MAX_DELETE_CONTACTS = 500;

export interface AssistantDraft {
  kind: 'TEMPLATE' | 'FLOW' | 'CAMPAIGN';
  id: string;
  name: string;
}

export interface AssistantMember {
  userId: string;
  role: Role;
  requestId: string;
}

/** What the tools of one request produced: drafts, pending actions and refused permissions. */
export interface AssistantOutcome {
  drafts: AssistantDraft[];
  actionIds: string[];
  refused: Permission[];
}

export const newOutcome = (): AssistantOutcome => ({ drafts: [], actionIds: [], refused: [] });

/** The permission a confirmed action needs, checked when it is prepared and again on confirm. */
export const ACTION_PERMISSION = {
  SEND_CAMPAIGN: 'campaigns.launch',
  SCHEDULE_CAMPAIGN: 'campaigns.launch',
  DELETE_CONTACTS: 'contacts.delete',
  DELETE_TAGS: 'contacts.manage',
} as const satisfies Record<string, Permission>;

const FLOW_GRAPH_GUIDE = [
  'The flow graph as a JSON string: {"version":1,"start":"<first step id>","triggers":[...],"steps":[...]}.',
  'Step ids: 1–40 lower-case letters, digits, - or _. A branch is a step id, or null to end there.',
  'Steps: {"id","type":"message","text","next"}; {"id","type":"question","text","answer":{"kind":"text"|"number"|"email"|"phone"|"date"},"answerName":"city","next"} (answer names: lower-case, start with a letter, unique in the flow);',
  '{"id","type":"buttons","text","buttons":[{"key":"yes","title":"Yes","next":"<step id>"}]} (1–3 buttons, titles up to 20 characters, every button leads to a step);',
  '{"id","type":"handover","note":"<for the team>"} hands the chat to a person; {"id","type":"end"} ends the flow.',
  'Answers can be used in later texts as {answer:city}. Triggers (optional): {"id":"keyword-1","kind":"KEYWORD","match":"CONTAINS","phrases":["price"],"canInterrupt":false}.',
  'Every step must be reachable from the start step.',
].join(' ');

const text = (description: string) => ({ type: 'string', description });
const optionalText = (description: string) => ({ type: ['string', 'null'], description });
const textList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
/** Strict tools list every property as required; optional values are null or an empty list. */
const object = (properties: Record<string, unknown>) => ({ type: 'object' as const, additionalProperties: false, required: Object.keys(properties), properties });

const DraftTemplateInput = z.strictObject({
  name: z.string(),
  language: z.string(),
  category: z.enum(['MARKETING', 'UTILITY']),
  headerText: z.string().nullable(),
  body: z.string(),
  bodyExamples: z.array(z.string()),
  footer: z.string().nullable(),
  buttons: z.array(z.strictObject({ type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']), text: z.string(), url: z.string().nullable(), phoneNumber: z.string().nullable() })),
});
const DraftFlowInput = z.strictObject({ name: z.string().trim().min(1).max(80), graphJson: z.string().max(200_000) });
const DraftCampaignInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  templateId: z.string(),
  numberId: z.string().nullable(),
  allOptedIn: z.boolean(),
  tags: z.array(z.string()),
  rules: z.array(z.strictObject({ attribute: z.string(), op: z.enum(ATTRIBUTE_OPERATORS), value: z.string().nullable() })),
  variables: z.array(
    z.strictObject({ variable: z.string(), source: z.enum(['field', 'attribute', 'static']), key: z.string().nullable(), value: z.string().nullable(), fallback: z.string().nullable() }),
  ),
});
const ReportInput = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const SendInput = z.strictObject({ campaignId: z.uuid(), sendAt: z.iso.datetime({ offset: true }).nullable() });
const DeleteInput = z.strictObject({ kind: z.enum(['CONTACTS', 'TAGS']), phones: z.array(z.string()).max(MAX_DELETE_CONTACTS), withTag: z.string().nullable(), tags: z.array(z.string()).max(50) });

/** Service errors become text the model can act on (fix the input, or explain to the member). */
function readable(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error(`The input is not valid: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  if (error instanceof AppError) {
    const details = (error.details ?? []).map((d) => `${d.field}: ${d.issue}`).join('; ');
    return new Error(details ? `${error.message} (${details})` : error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

const usd = (value: number | null | undefined) => (typeof value === 'number' ? `USD ${value.toFixed(2)}` : 'unknown (no rate card)');

@Injectable()
export class AssistantTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly flows: FlowsService,
    private readonly reserved: ReservedKeywords,
    private readonly campaigns: CampaignsService,
    private readonly launch: LaunchService,
    private readonly estimate: EstimateService,
    private readonly reports: ReportsService,
    private readonly settings: SettingsService,
  ) {}

  /** The tools of one request, sorted by name so the cached prefix stays the same. */
  build(member: AssistantMember, outcome: AssistantOutcome): ClaudeTool[] {
    const guarded =
      (permission: Permission, what: string, work: (input: Record<string, unknown>) => Promise<string>) =>
      async (input: Record<string, unknown>): Promise<string> => {
        // The member's own permissions (FR-045): a refusal is explained, not worked around.
        if (!can(member.role, permission)) {
          outcome.refused.push(permission);
          throw new Error(`Not allowed: the member's role (${member.role.toLowerCase()}) cannot ${what}. Tell the member why; do not try another way.`);
        }
        try {
          return await work(input);
        } catch (error) {
          throw readable(error);
        }
      };

    const tools: ClaudeTool[] = [
      {
        name: 'draft_template',
        description:
          'Saves a WhatsApp message template as a draft for the member to review. It is NOT submitted to Meta; the member submits it from the template editor.',
        inputSchema: object({
          name: text('Template name: lower-case letters, digits and _, for example weekend_sale.'),
          language: text('Language code, for example en, en_US or ar.'),
          category: { type: 'string', enum: ['MARKETING', 'UTILITY'], description: 'MARKETING for offers and news; UTILITY for updates about an order or an account.' },
          headerText: optionalText('Header text (up to 60 characters), or null for no header.'),
          body: text('The message body (up to 1,024 characters). Variables are {{1}}, {{2}} … in order.'),
          bodyExamples: textList('One example value per body variable, in order; empty when there are none.'),
          footer: optionalText('Footer text (up to 60 characters), or null.'),
          buttons: {
            type: 'array',
            description: 'Buttons; empty for none. Quick replies, or up to two links or one phone number.',
            items: object({
              type: { type: 'string', enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] },
              text: text('Button text, up to 25 characters.'),
              url: optionalText('For URL buttons the https address; otherwise null.'),
              phoneNumber: optionalText('For PHONE_NUMBER buttons the number in international format; otherwise null.'),
            }),
          },
        }),
        run: guarded('templates.manage', 'create templates', async (raw) => {
          const input = DraftTemplateInput.parse(raw);
          const template = await this.templates.saveDraft(
            {
              wabaId: await this.defaultAccount(),
              name: input.name,
              language: input.language,
              category: input.category,
              header: input.headerText ? { format: 'TEXT', text: input.headerText } : null,
              body: { text: input.body, ...(input.bodyExamples.length ? { examples: input.bodyExamples } : {}) },
              footer: input.footer,
              buttons: input.buttons.map((b) => ({ type: b.type, text: b.text, ...(b.url ? { url: b.url } : {}), ...(b.phoneNumber ? { phoneNumber: b.phoneNumber } : {}) })),
            },
            member.userId,
          );
          outcome.drafts.push({ kind: 'TEMPLATE', id: template.id, name: template.name });
          return `Saved the template draft "${template.name}" (${template.language}). It is not submitted to Meta: the member reviews it in the template editor and submits it there.`;
        }),
      },
      {
        name: 'draft_flow',
        description:
          'Saves a chatbot flow as an unpublished draft for the member to review. It must pass the publish checks; problems come back so you can fix them and try again.',
        inputSchema: object({ name: text('Flow name, up to 80 characters.'), graphJson: text(FLOW_GRAPH_GUIDE) }),
        run: guarded('flows.manage', 'build flows', async (raw) => {
          const input = DraftFlowInput.parse(raw);
          let json: unknown;
          try {
            json = JSON.parse(input.graphJson);
          } catch {
            throw new Error('graphJson is not valid JSON.');
          }
          const parsed = FlowGraphSchema.safeParse(json);
          if (!parsed.success) {
            throw new Error(`The flow graph does not match the format: ${parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`).join('; ')}`);
          }
          const problems = validateForPublish(parsed.data, { reservedKeywords: await this.reserved.list() });
          if (problems.length) {
            throw new Error(`The flow would not pass the publish checks: ${problems.slice(0, 10).map((p) => (p.stepId ? `${p.stepId}: ${p.message}` : p.message)).join('; ')}. Fix them and call draft_flow again.`);
          }
          const flow = await this.flows.create({ name: input.name }, { userId: member.userId });
          await this.flows.saveDraft(flow.id, { graph: parsed.data, draftRevision: flow.draftRevision }, member.userId);
          outcome.drafts.push({ kind: 'FLOW', id: flow.id, name: flow.name });
          return `Saved the flow draft "${flow.name}". It is not published: the member reviews it in the flow editor and publishes it there.`;
        }),
      },
      {
        name: 'draft_campaign',
        description:
          'Saves a campaign as a draft: an approved template, a sending number and an audience. It is NOT scheduled or sent; use propose_campaign_send for that.',
        inputSchema: object({
          name: text('Campaign name, up to 120 characters.'),
          templateId: text('Id of an approved template from the workspace list.'),
          numberId: optionalText('Id of the sending number from the workspace list, or null for the first connected number.'),
          allOptedIn: { type: 'boolean', description: 'true: everyone who opted in. false: the contacts that match all the tags and rules.' },
          tags: textList('Tag names the contacts must all have; empty for none.'),
          rules: {
            type: 'array',
            description: 'Attribute rules the contacts must all match; empty for none.',
            items: object({
              attribute: text('Attribute key from the workspace list.'),
              op: { type: 'string', enum: [...ATTRIBUTE_OPERATORS] },
              value: optionalText('The value to compare with, or null for is_true and is_false.'),
            }),
          },
          variables: {
            type: 'array',
            description: "One entry per template variable (the template's variables in the workspace list).",
            items: object({
              variable: text('The variable, for example BODY.1.'),
              source: { type: 'string', enum: ['field', 'attribute', 'static'] },
              key: optionalText('For field: name or phone. For attribute: the attribute key. For static: null.'),
              value: optionalText('For static: the text. Otherwise null.'),
              fallback: optionalText('Text used when the contact has no value, or null.'),
            }),
          },
        }),
        run: guarded('campaigns.manage', 'create campaigns', async (raw) => {
          const input = DraftCampaignInput.parse(raw);
          const types = new Map(
            (await this.prisma.attributeDefinition.findMany({ where: { key: { in: input.rules.map((r) => r.attribute) } }, select: { key: true, type: true } })).map((a) => [a.key, a.type]),
          );
          const rules = input.rules.map((rule) => {
            const type = types.get(rule.attribute);
            if (!type) throw new Error(`There is no attribute "${rule.attribute}".`);
            if (rule.value === null) return { attr: rule.attribute, op: rule.op };
            const value = type === 'NUMBER' ? Number(rule.value) : type === 'BOOLEAN' ? rule.value === 'true' : rule.value;
            if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`"${rule.attribute}" holds numbers; "${rule.value}" is not one.`);
            return { attr: rule.attribute, op: rule.op, value };
          });
          const all = [...input.tags.map((tag) => ({ tag: normaliseTag(tag) })), ...rules];
          if (!input.allOptedIn && !all.length) throw new Error('Give at least one tag or rule, or set allOptedIn to true.');
          const campaignInput = CampaignInputSchema.parse({
            name: input.name,
            numberId: input.numberId ?? (await this.defaultNumberId()),
            templateId: input.templateId,
            audienceType: input.allOptedIn ? 'ALL_OPTED_IN' : 'FILTER',
            audienceFilter: input.allOptedIn ? null : { all },
            variableMapping: Object.fromEntries(
              input.variables.map((v) => [
                v.variable,
                { source: v.source, ...(v.key ? { key: v.key } : {}), ...(v.value !== null ? { value: v.value } : {}), ...(v.fallback ? { fallback: v.fallback } : {}) },
              ]),
            ),
            headerMediaAssetId: null,
          });
          const campaign = await this.campaigns.create({ ...campaignInput, name: input.name }, member.userId);
          outcome.drafts.push({ kind: 'CAMPAIGN', id: campaign.id, name: campaign.name });
          return `Saved the campaign draft "${campaign.name}" (id ${campaign.id}). It is not scheduled or sent. To send or schedule it, call propose_campaign_send; the member confirms on a preview.`;
        }),
      },
      {
        name: 'report_summary',
        description: 'Campaign results for a period: the same figures as the campaign reports (sent, delivered, read, failed, rates and estimated cost).',
        inputSchema: object({ from: text('First day, YYYY-MM-DD, in the company time zone.'), to: text('Last day, YYYY-MM-DD, included.') }),
        run: guarded('campaigns.view', 'see campaign reports', async (raw) => {
          const input = ReportInput.parse(raw);
          if (input.from > input.to) throw new Error('"from" must not be after "to".');
          const { defaultTimezone } = await this.settings.get();
          const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; state: string; launched_at: Date }>>`
            SELECT id, name, state::text AS state, launched_at FROM campaigns
             WHERE launched_at IS NOT NULL
               AND (launched_at AT TIME ZONE ${defaultTimezone})::date BETWEEN ${input.from}::date AND ${input.to}::date
             ORDER BY launched_at, id LIMIT 50`;
          const campaigns = [];
          for (const row of rows) {
            const report = await this.reports.report(row.id);
            campaigns.push({
              id: row.id,
              name: row.name,
              state: row.state,
              launchedAt: row.launched_at.toISOString(),
              totals: report.totals,
              deliveryRate: report.deliveryRate,
              readRate: report.readRate,
              topFailureReasons: report.failureReasons.slice(0, 3),
              estimatedCostUsd: report.estimatedCostUsd,
            });
          }
          return JSON.stringify({ from: input.from, to: input.to, timezone: defaultTimezone, campaigns, ...(campaigns.length === 50 ? { note: 'Only the first 50 campaigns are listed.' } : {}) });
        }),
      },
      {
        name: 'propose_campaign_send',
        description:
          'Prepares sending a draft campaign now or at a time. Nothing is sent: the member sees a preview (template, recipients, estimated cost) and confirms it in the assistant panel within 30 minutes.',
        inputSchema: object({
          campaignId: text('Id of a draft campaign.'),
          sendAt: optionalText('When to send, as an ISO 8601 date-time with offset (for example 2026-11-28T09:00:00+04:00); null to send right after the member confirms.'),
        }),
        run: guarded('campaigns.launch', 'send or schedule campaigns', async (raw) => {
          const input = SendInput.parse(raw);
          const campaign = await this.launch.load(input.campaignId);
          if (campaign.state !== 'DRAFT') throw new Error(`The campaign "${campaign.name}" is ${campaign.state.toLowerCase()}, not a draft, so it cannot be sent from here.`);
          if (input.sendAt && Date.parse(input.sendAt) <= Date.now() + 60_000) throw new Error('sendAt must be at least a minute in the future.');
          const { template, number } = await this.launch.validate(campaign);
          const estimate = await this.estimate.estimate(campaign.id);
          const cost = estimate.estimatedCostUsd ?? null;
          const action = await this.prisma.assistantAction.create({
            data: {
              requestId: member.requestId,
              userId: member.userId,
              kind: input.sendAt ? 'SCHEDULE_CAMPAIGN' : 'SEND_CAMPAIGN',
              params: { campaignId: campaign.id, scheduledAt: input.sendAt },
              preview: {
                campaign: { id: campaign.id, name: campaign.name },
                template: { id: template.id, name: template.name, language: template.language },
                number: { id: number.id, label: number.label },
                recipients: estimate.eligible,
                excluded: estimate.excluded,
                estimatedCostUsd: cost,
                sendAt: input.sendAt,
                warning: estimate.messagingLimitWarning ?? null,
              } as Prisma.InputJsonValue,
              expiresAt: new Date(Date.now() + ACTION_TTL_MS),
            },
          });
          outcome.actionIds.push(action.id);
          const when = input.sendAt ? `scheduling "${campaign.name}" for ${input.sendAt}` : `sending "${campaign.name}" now`;
          return `Prepared ${when}: ${estimate.eligible} recipients, estimated cost ${usd(cost)}. Nothing is sent until the member confirms this preview in the assistant panel within 30 minutes.`;
        }),
      },
      {
        name: 'propose_delete',
        description:
          'Prepares deleting contacts (by phone number or by tag) or tags. Nothing is deleted: the member sees what would be deleted and confirms it in the assistant panel within 30 minutes.',
        inputSchema: object({
          kind: { type: 'string', enum: ['CONTACTS', 'TAGS'] },
          phones: textList('CONTACTS: phone numbers of the contacts to delete; may be empty.'),
          withTag: optionalText('CONTACTS: delete the contacts that have this tag; otherwise null.'),
          tags: textList('TAGS: names of the tags to delete (contacts stay); otherwise empty.'),
        }),
        run: async (raw) => {
          const input = DeleteInput.safeParse(raw);
          if (!input.success) throw readable(input.error);
          return input.data.kind === 'CONTACTS'
            ? guarded(ACTION_PERMISSION.DELETE_CONTACTS, 'delete contacts', () => this.proposeContactDeletion(member, outcome, input.data))(raw)
            : guarded(ACTION_PERMISSION.DELETE_TAGS, 'delete tags', () => this.proposeTagDeletion(member, outcome, input.data))(raw);
        },
      },
    ];
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async proposeContactDeletion(member: AssistantMember, outcome: AssistantOutcome, input: z.infer<typeof DeleteInput>): Promise<string> {
    const { defaultCountryCode } = await this.settings.get();
    const phones = [...new Set(input.phones.map((p) => normalizePhone(p, defaultCountryCode)?.e164).filter((p): p is string => Boolean(p)))];
    const tag = input.withTag ? normaliseTag(input.withTag) : null;
    const where: Prisma.ContactWhereInput[] = [...(phones.length ? [{ phoneE164: { in: phones } }] : []), ...(tag ? [{ tags: { some: { tag: { name: tag } } } }] : [])];
    if (!where.length) throw new Error('Give the phone numbers of the contacts, or a tag.');
    const contacts = await this.prisma.contact.findMany({ where: { OR: where }, select: { id: true, name: true, phoneE164: true }, orderBy: { createdAt: 'asc' }, take: MAX_DELETE_CONTACTS + 1 });
    if (!contacts.length) throw new Error('No contacts match.');
    if (contacts.length > MAX_DELETE_CONTACTS) throw new Error(`More than ${MAX_DELETE_CONTACTS} contacts match; ask for a smaller group.`);
    const action = await this.prisma.assistantAction.create({
      data: {
        requestId: member.requestId,
        userId: member.userId,
        kind: 'DELETE_CONTACTS',
        params: { contactIds: contacts.map((c) => c.id) },
        preview: {
          count: contacts.length,
          withTag: tag,
          phonesGiven: phones.length,
          sample: contacts.slice(0, 10).map((c) => ({ name: c.name, phone: maskPhone(c.phoneE164) })),
        } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ACTION_TTL_MS),
      },
    });
    outcome.actionIds.push(action.id);
    return `Prepared deleting ${contacts.length} contact(s) with their chats and history. Nothing is deleted until the member confirms this preview in the assistant panel within 30 minutes.`;
  }

  private async proposeTagDeletion(member: AssistantMember, outcome: AssistantOutcome, input: z.infer<typeof DeleteInput>): Promise<string> {
    const names = [...new Set(input.tags.map(normaliseTag).filter(Boolean))];
    if (!names.length) throw new Error('Give the names of the tags to delete.');
    const tags = await this.prisma.tag.findMany({ where: { name: { in: names } }, include: { _count: { select: { contacts: true } } }, orderBy: { name: 'asc' } });
    if (!tags.length) throw new Error('No tags with these names exist.');
    const found = new Set(tags.map((t) => t.name));
    const action = await this.prisma.assistantAction.create({
      data: {
        requestId: member.requestId,
        userId: member.userId,
        kind: 'DELETE_TAGS',
        params: { tagIds: tags.map((t) => t.id) },
        preview: { tags: tags.map((t) => ({ id: t.id, name: t.name, contacts: t._count.contacts })), notFound: names.filter((n) => !found.has(n)) } as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ACTION_TTL_MS),
      },
    });
    outcome.actionIds.push(action.id);
    return `Prepared deleting ${tags.length} tag(s); contacts keep everything else. Nothing is deleted until the member confirms this preview in the assistant panel within 30 minutes.`;
  }

  /** The account of the first connected number: templates belong to a WhatsApp Business Account. */
  private async defaultAccount(): Promise<string> {
    const number =
      (await this.prisma.whatsAppNumber.findFirst({ where: { connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' }, select: { wabaId: true } })) ??
      (await this.prisma.whatsAppNumber.findFirst({ orderBy: { createdAt: 'asc' }, select: { wabaId: true } }));
    if (!number) throw new Error('No WhatsApp number is connected yet, so there is no account to draft a template for.');
    return number.wabaId;
  }

  private async defaultNumberId(): Promise<string> {
    const number = await this.prisma.whatsAppNumber.findFirst({ where: { connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!number) throw new Error('No WhatsApp number is connected, so the campaign has nothing to send from.');
    return number.id;
  }
}
