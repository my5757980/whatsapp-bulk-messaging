import { describe, expect, it, vi } from 'vitest';
import { ACTION_TTL_MS, AssistantTools, newOutcome, type AssistantMember } from '../../../src/modules/ai/assistant/assistant-tools.js';
import type { ClaudeTool } from '../../../src/modules/ai/claude/claude.client.js';

// 004 T096: the team assistant's tools (research R14, FR-042–FR-045). Each tool checks the member's
// permission first, drafts stay drafts, and propose tools only store a preview: no tool sends,
// spends or deletes.
const IDS = {
  request: '0190a000-0000-7000-8000-000000000001',
  campaign: '0190a000-0000-7000-8000-000000000002',
  template: '0190a000-0000-7000-8000-000000000003',
  number: '0190a000-0000-7000-8000-000000000004',
  flow: '0190a000-0000-7000-8000-000000000005',
  tag: '0190a000-0000-7000-8000-000000000006',
};

const NAME_AND_CITY = {
  version: 1,
  start: 'ask-name',
  triggers: [],
  steps: [
    { id: 'ask-name', type: 'question', text: 'What is your name?', answer: { kind: 'text' }, answerName: 'name', retryText: 'Please type your name.', next: 'ask-city' },
    { id: 'ask-city', type: 'question', text: 'Which city are you in?', answer: { kind: 'text' }, answerName: 'city', retryText: 'Please type your city.', next: 'person' },
    { id: 'person', type: 'handover', note: 'Name and city collected.' },
  ],
};

/** A valid call of every tool, for the permission and "nothing runs" checks. */
const CALLS: Record<string, Record<string, unknown>> = {
  draft_template: {
    name: 'weekend_sale',
    language: 'en',
    category: 'MARKETING',
    headerText: 'Weekend sale',
    body: 'Hi {{1}}, everything is 20% off this weekend.',
    bodyExamples: ['Sara'],
    footer: null,
    buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/sale', phoneNumber: null }],
  },
  draft_flow: { name: 'Name and city', graphJson: JSON.stringify(NAME_AND_CITY) },
  draft_campaign: {
    name: 'Weekend sale VIP',
    templateId: IDS.template,
    numberId: null,
    allOptedIn: false,
    tags: ['VIP'],
    rules: [
      { attribute: 'city', op: 'eq', value: 'Dubai' },
      { attribute: 'spend', op: 'gt', value: '100' },
    ],
    variables: [{ variable: 'BODY.1', source: 'field', key: 'name', value: null, fallback: 'there' }],
  },
  report_summary: { from: '2026-11-16', to: '2026-11-22' },
  propose_campaign_send: { campaignId: IDS.campaign, sendAt: null },
  propose_delete: { kind: 'TAGS', phones: [], withTag: null, tags: ['VIP'] },
};

function setup() {
  const actions: Array<Record<string, unknown>> = [];
  const prisma = {
    whatsAppNumber: { findFirst: vi.fn(async () => ({ id: IDS.number, wabaId: 'WABA_1' })) },
    attributeDefinition: {
      findMany: vi.fn(async () => [
        { key: 'city', type: 'TEXT' },
        { key: 'spend', type: 'NUMBER' },
      ]),
    },
    assistantAction: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        actions.push(data);
        return { id: `action-${actions.length}`, ...data };
      }),
    },
    contact: {
      findMany: vi.fn(async () => [
        { id: 'contact-1', name: 'Sara', phoneE164: '+971501234567' },
        { id: 'contact-2', name: null, phoneE164: '+971501234568' },
      ]),
    },
    tag: { findMany: vi.fn(async () => [{ id: IDS.tag, name: 'vip', _count: { contacts: 12 } }]), deleteMany: vi.fn() },
    $queryRaw: vi.fn(async () => [{ id: IDS.campaign, name: 'Weekend sale', state: 'COMPLETED', launched_at: new Date('2026-11-17T08:00:00Z') }]),
  };
  const templates = { saveDraft: vi.fn(async (input: { name: string; language: string }) => ({ id: IDS.template, name: input.name, language: input.language })), create: vi.fn() };
  const flows = {
    create: vi.fn(async (input: { name: string }) => ({ id: IDS.flow, name: input.name, draftRevision: 0 })),
    saveDraft: vi.fn(async () => ({ draftRevision: 1, problems: [] })),
  };
  const reserved = { list: vi.fn(async () => ['stop']) };
  const campaigns = { create: vi.fn(async (input: { name: string }) => ({ id: IDS.campaign, name: input.name })) };
  const launch = {
    load: vi.fn(async () => ({ id: IDS.campaign, name: 'Weekend sale', state: 'DRAFT' })),
    validate: vi.fn(async () => ({ template: { id: IDS.template, name: 'weekend_sale', language: 'en' }, number: { id: IDS.number, label: 'Main' } })),
    launch: vi.fn(),
  };
  const estimate = {
    estimate: vi.fn(async () => ({
      eligible: 1240,
      excluded: { optedOut: 3, noOptIn: 0, invalidNumber: 0, duplicate: 0, missingVariable: 0 },
      messagingLimitWarning: null,
      previews: [],
      estimatedCostUsd: 18.6,
    })),
  };
  const report = {
    campaignId: IDS.campaign,
    totals: { queued: 0, sent: 10, delivered: 80, read: 50, failed: 2, skipped: 0 },
    deliveryRate: 0.9,
    readRate: 0.38,
    failureReasons: [{ code: 131026, reason: 'Not on WhatsApp', count: 2 }],
    estimatedCostUsd: 4.2,
    costIsEstimate: true,
  };
  const reports = { report: vi.fn(async () => report) };
  const settings = { get: vi.fn(async () => ({ defaultTimezone: 'Asia/Dubai', defaultCountryCode: 'AE' })) };
  const tools = new AssistantTools(
    prisma as never,
    templates as never,
    flows as never,
    reserved as never,
    campaigns as never,
    launch as never,
    estimate as never,
    reports as never,
    settings as never,
  );
  /** The services that would send, spend or delete. */
  const dangerous = [templates.create, launch.launch, prisma.tag.deleteMany];
  return { tools, prisma, templates, flows, campaigns, launch, estimate, reports, report, actions, dangerous };
}

const member = (role: 'ADMIN' | 'MANAGER' | 'AGENT'): AssistantMember => ({ userId: 'user-1', role, requestId: IDS.request });
const tool = (list: ClaudeTool[], name: string) => list.find((t) => t.name === name)!;

/** Strict tools: every object closes its properties and lists them all as required. */
function expectStrict(schema: unknown, path: string): void {
  const node = schema as { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown };
  if (node.type === 'object') {
    expect(node.additionalProperties, path).toBe(false);
    expect([...(node.required ?? [])].sort(), path).toEqual(Object.keys(node.properties ?? {}).sort());
    for (const [key, value] of Object.entries(node.properties ?? {})) expectStrict(value, `${path}.${key}`);
  }
  if (node.items) expectStrict(node.items, `${path}[]`);
}

describe('team assistant tools', () => {
  it('offers the six tools, sorted, with strict input schemas', () => {
    const { tools } = setup();
    const list = tools.build(member('MANAGER'), newOutcome());
    expect(list.map((t) => t.name)).toEqual(['draft_campaign', 'draft_flow', 'draft_template', 'propose_campaign_send', 'propose_delete', 'report_summary']);
    for (const t of list) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expectStrict(t.inputSchema, t.name);
    }
  });

  it('refuses each tool to a role without its permission, before any service is called', async () => {
    const { tools, templates, flows, campaigns, launch, estimate, reports, prisma } = setup();
    const outcome = newOutcome();
    const list = tools.build(member('AGENT'), outcome);
    for (const [name, input] of Object.entries(CALLS)) {
      if (name === 'report_summary') continue;
      await expect(tool(list, name).run(input), name).rejects.toThrow(/Not allowed: the member's role \(agent\)/);
    }
    expect([...outcome.refused].sort()).toEqual(['campaigns.launch', 'campaigns.manage', 'contacts.manage', 'flows.manage', 'templates.manage']);
    for (const fn of [templates.saveDraft, flows.create, campaigns.create, launch.load, estimate.estimate, prisma.assistantAction.create]) expect(fn).not.toHaveBeenCalled();
    expect(outcome.drafts).toEqual([]);
    expect(outcome.actionIds).toEqual([]);
    // Campaign reports need only campaigns.view, which agents have.
    await tool(list, 'report_summary').run(CALLS.report_summary!);
    expect(reports.report).toHaveBeenCalledTimes(1);
  });

  it('draft_template saves a draft with the button and does not submit it to Meta', async () => {
    const { tools, templates } = setup();
    const outcome = newOutcome();
    const result = await tool(tools.build(member('MANAGER'), outcome), 'draft_template').run(CALLS.draft_template!);
    expect(templates.saveDraft).toHaveBeenCalledWith(
      {
        wabaId: 'WABA_1',
        name: 'weekend_sale',
        language: 'en',
        category: 'MARKETING',
        header: { format: 'TEXT', text: 'Weekend sale' },
        body: { text: 'Hi {{1}}, everything is 20% off this weekend.', examples: ['Sara'] },
        footer: null,
        buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/sale' }],
      },
      'user-1',
    );
    expect(templates.create).not.toHaveBeenCalled();
    expect(outcome.drafts).toEqual([{ kind: 'TEMPLATE', id: IDS.template, name: 'weekend_sale' }]);
    expect(result).toContain('not submitted to Meta');
  });

  it('draft_flow checks the graph with the 003 schema and publish rules before saving an unpublished draft', async () => {
    const { tools, flows } = setup();
    const outcome = newOutcome();
    const draftFlow = tool(tools.build(member('MANAGER'), outcome), 'draft_flow');
    await expect(draftFlow.run({ name: 'Broken', graphJson: '{"version":1,' })).rejects.toThrow('graphJson is not valid JSON');
    await expect(draftFlow.run({ name: 'Wrong', graphJson: JSON.stringify({ version: 1, start: 'x', steps: [{ id: 'x', type: 'teleport' }] }) })).rejects.toThrow(
      'does not match the format',
    );
    const orphan = { ...NAME_AND_CITY, steps: [...NAME_AND_CITY.steps, { id: 'orphan', type: 'message', text: 'Hello', next: null }] };
    await expect(draftFlow.run({ name: 'Orphan', graphJson: JSON.stringify(orphan) })).rejects.toThrow(/publish checks: orphan: No branch leads to this step/);
    expect(flows.create).not.toHaveBeenCalled();

    await draftFlow.run(CALLS.draft_flow!);
    expect(flows.create).toHaveBeenCalledWith({ name: 'Name and city' }, { userId: 'user-1' });
    expect(flows.saveDraft).toHaveBeenCalledWith(IDS.flow, { graph: expect.objectContaining({ start: 'ask-name' }), draftRevision: 0 }, 'user-1');
    expect(outcome.drafts).toEqual([{ kind: 'FLOW', id: IDS.flow, name: 'Name and city' }]);
  });

  it('draft_campaign builds the audience and the variables and leaves the campaign unscheduled', async () => {
    const { tools, campaigns, launch } = setup();
    const outcome = newOutcome();
    const draftCampaign = tool(tools.build(member('MANAGER'), outcome), 'draft_campaign');
    await draftCampaign.run(CALLS.draft_campaign!);
    expect(campaigns.create).toHaveBeenCalledWith(
      {
        name: 'Weekend sale VIP',
        numberId: IDS.number,
        templateId: IDS.template,
        audienceType: 'FILTER',
        audienceFilter: {
          all: [
            { tag: 'vip' },
            { attr: 'city', op: 'eq', value: 'Dubai' },
            { attr: 'spend', op: 'gt', value: 100 },
          ],
        },
        variableMapping: { 'BODY.1': { source: 'field', key: 'name', fallback: 'there' } },
        headerMediaAssetId: null,
      },
      'user-1',
    );
    expect(launch.launch).not.toHaveBeenCalled();
    expect(outcome.drafts).toEqual([{ kind: 'CAMPAIGN', id: IDS.campaign, name: 'Weekend sale VIP' }]);
    await expect(draftCampaign.run({ ...CALLS.draft_campaign!, rules: [{ attribute: 'shoe_size', op: 'eq', value: '42' }] })).rejects.toThrow('There is no attribute "shoe_size"');
    await expect(draftCampaign.run({ ...CALLS.draft_campaign!, tags: [], rules: [] })).rejects.toThrow('at least one tag or rule');
  });

  it('propose_campaign_send stores a pending preview with the recipients and cost, and sends nothing', async () => {
    const { tools, actions, launch } = setup();
    const outcome = newOutcome();
    const propose = tool(tools.build(member('MANAGER'), outcome), 'propose_campaign_send');
    const before = Date.now();
    const result = await propose.run(CALLS.propose_campaign_send!);
    expect(actions[0]).toMatchObject({
      requestId: IDS.request,
      userId: 'user-1',
      kind: 'SEND_CAMPAIGN',
      params: { campaignId: IDS.campaign, scheduledAt: null },
      preview: { campaign: { id: IDS.campaign, name: 'Weekend sale' }, template: { name: 'weekend_sale' }, recipients: 1240, estimatedCostUsd: 18.6, sendAt: null },
    });
    const expiresAt = (actions[0]!.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + ACTION_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ACTION_TTL_MS);
    expect(result).toContain('1240 recipients, estimated cost USD 18.60');
    expect(result).toContain('Nothing is sent until the member confirms');
    expect(outcome.actionIds).toEqual(['action-1']);

    const sendAt = new Date(Date.now() + 86_400_000).toISOString().replace('Z', '+00:00');
    await propose.run({ campaignId: IDS.campaign, sendAt });
    expect(actions[1]).toMatchObject({ kind: 'SCHEDULE_CAMPAIGN', params: { scheduledAt: sendAt } });
    await expect(propose.run({ campaignId: IDS.campaign, sendAt: '2020-01-01T09:00:00+04:00' })).rejects.toThrow('in the future');
    launch.load.mockResolvedValueOnce({ id: IDS.campaign, name: 'Weekend sale', state: 'RUNNING' });
    await expect(propose.run(CALLS.propose_campaign_send!)).rejects.toThrow('is running, not a draft');
    expect(launch.launch).not.toHaveBeenCalled();
  });

  it('propose_delete: managers cannot delete contacts, admins get a preview, and tags need contacts.manage', async () => {
    const { tools, actions, prisma } = setup();
    const managerOutcome = newOutcome();
    const asManager = tool(tools.build(member('MANAGER'), managerOutcome), 'propose_delete');
    await expect(asManager.run({ kind: 'CONTACTS', phones: [], withTag: 'VIP', tags: [] })).rejects.toThrow(/Not allowed: the member's role \(manager\) cannot delete contacts/);
    expect(managerOutcome.refused).toEqual(['contacts.delete']);
    expect(actions).toEqual([]);

    const adminOutcome = newOutcome();
    await tool(tools.build(member('ADMIN'), adminOutcome), 'propose_delete').run({ kind: 'CONTACTS', phones: ['050 123 4567'], withTag: 'VIP', tags: [] });
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ phoneE164: { in: ['+971501234567'] } }, { tags: { some: { tag: { name: 'vip' } } } }] } }),
    );
    expect(actions[0]).toMatchObject({ kind: 'DELETE_CONTACTS', params: { contactIds: ['contact-1', 'contact-2'] }, preview: { count: 2, withTag: 'vip' } });
    // The preview never shows a full phone number.
    expect(JSON.stringify(actions[0]!.preview)).not.toContain('+971501234567');

    await asManager.run(CALLS.propose_delete!);
    expect(actions[1]).toMatchObject({ kind: 'DELETE_TAGS', params: { tagIds: [IDS.tag] }, preview: { tags: [{ id: IDS.tag, name: 'vip', contacts: 12 }], notFound: [] } });
    expect(prisma.tag.deleteMany).not.toHaveBeenCalled();
  });

  it('report_summary returns the figures of the campaign reports for the period', async () => {
    const { tools, report, reports } = setup();
    const summary = tool(tools.build(member('MANAGER'), newOutcome()), 'report_summary');
    const result = JSON.parse(await summary.run(CALLS.report_summary!)) as { timezone: string; campaigns: Array<Record<string, unknown>> };
    expect(reports.report).toHaveBeenCalledWith(IDS.campaign);
    expect(result.timezone).toBe('Asia/Dubai');
    expect(result.campaigns).toEqual([
      {
        id: IDS.campaign,
        name: 'Weekend sale',
        state: 'COMPLETED',
        launchedAt: '2026-11-17T08:00:00.000Z',
        totals: report.totals,
        deliveryRate: report.deliveryRate,
        readRate: report.readRate,
        topFailureReasons: report.failureReasons,
        estimatedCostUsd: report.estimatedCostUsd,
      },
    ]);
    await expect(summary.run({ from: '2026-11-22', to: '2026-11-16' })).rejects.toThrow('"from" must not be after "to"');
    await expect(summary.run({ from: 'last week', to: '2026-11-16' })).rejects.toThrow('The input is not valid');
  });

  it('never sends, spends or deletes, whatever is asked', async () => {
    const { tools, dangerous } = setup();
    const list = tools.build(member('ADMIN'), newOutcome());
    for (const [name, input] of Object.entries(CALLS)) await tool(list, name).run(input);
    await tool(list, 'propose_delete').run({ kind: 'CONTACTS', phones: ['+971501234567'], withTag: null, tags: [] });
    for (const fn of dangerous) expect(fn).not.toHaveBeenCalled();
  });
});
