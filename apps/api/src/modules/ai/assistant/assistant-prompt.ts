import { Injectable } from '@nestjs/common';
import { ALL_PERMISSIONS, can, type Role } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';

// The team assistant's prompt (004 T100, research R14, our own text). The system prompt is the same
// for every request, so it is cached with the tools; the member's role and the workspace follow in
// the first user message. No contact phone numbers or names are sent.

export const ASSISTANT_SYSTEM = `You are the team assistant of a WhatsApp business messaging platform. Admins and managers ask you, in plain words, to prepare message templates, chatbot flows and campaigns, and to answer questions about campaign results.

How you work:
- You create drafts only. A template draft is not submitted to Meta, a flow draft is not published and a campaign draft is not scheduled or sent. The member reviews the draft and does that step.
- Sending, scheduling and deleting are never done by you. propose_campaign_send and propose_delete only prepare a preview; the member confirms it in the assistant panel. Say so when you prepare one.
- You act with the member's own permissions. When a tool answers "Not allowed", explain to the member which role can do it; do not look for another way.
- There are no tools for settings, limits, users, numbers or billing. When asked to change one, say you cannot, and who can (for example: only an admin can change the AI reply limit, on the AI usage page).
- Use only the ids in the workspace list; never invent an id, a price or a figure. Figures about campaigns come from report_summary.
- When a tool reports a problem with your input, fix it and call the tool again.

Answer in the member's language, in short plain text: what you did, the drafts to review and any preview waiting for confirmation.`;

const LIST_LIMIT = 50;

@Injectable()
export class AssistantContext {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** The member's role and what the workspace holds, so the model can use real ids. */
  async describe(role: Role, now: Date = new Date()): Promise<string> {
    const { defaultTimezone } = await this.settings.get();
    const [numbers, templates, tags, attributes, campaigns] = await Promise.all([
      this.prisma.whatsAppNumber.findMany({ orderBy: { createdAt: 'asc' }, take: LIST_LIMIT, select: { id: true, label: true, wabaId: true, connectionStatus: true } }),
      this.prisma.template.findMany({
        where: { status: 'APPROVED' },
        orderBy: { name: 'asc' },
        take: LIST_LIMIT,
        select: { id: true, name: true, language: true, category: true, variables: true },
      }),
      this.prisma.tag.findMany({ orderBy: { name: 'asc' }, take: LIST_LIMIT, include: { _count: { select: { contacts: true } } } }),
      this.prisma.attributeDefinition.findMany({ orderBy: { key: 'asc' }, take: LIST_LIMIT, select: { key: true, type: true } }),
      this.prisma.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, name: true, state: true, launchedAt: true } }),
    ]);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: defaultTimezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).format(now);
    const workspace = {
      member: { role, permissions: ALL_PERMISSIONS.filter((p) => can(role, p)) },
      today,
      timezone: defaultTimezone,
      numbers: numbers.map((n) => ({ id: n.id, label: n.label, account: n.wabaId, connected: n.connectionStatus === 'CONNECTED' })),
      approvedTemplates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        variables: (Array.isArray(t.variables) ? (t.variables as Array<{ key?: string }>) : []).map((v) => v.key).filter(Boolean),
      })),
      tags: tags.map((t) => ({ name: t.name, contacts: t._count.contacts })),
      attributes: attributes.map((a) => ({ key: a.key, type: a.type })),
      recentCampaigns: campaigns.map((c) => ({ id: c.id, name: c.name, state: c.state, launchedAt: c.launchedAt?.toISOString() ?? null })),
    };
    return `<workspace>\n${JSON.stringify(workspace)}\n</workspace>`;
  }
}
