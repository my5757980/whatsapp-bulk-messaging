import { randomUUID } from 'node:crypto';
import { FlowGraphSchema, validateForPublish } from '@wbm/shared';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AssistantRunner } from '../../src/modules/ai/assistant/assistant.runner.js';
import { ReportsService } from '../../src/modules/reports/reports.service.js';
import { CLAUDE, claudeStream, toolResultsOf } from '../support/claude-stream.js';
import { META_BASE, META_VERSION, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T097: US9 - the team assistant drafts, previews and confirms (FR-042–FR-046, research R14).
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

describe('AI agents: team assistant (US9)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let agentMember: SignedInAgent;
  let number: { id: string; wabaId: string };
  let template: { id: string; name: string };
  let original: Record<string, unknown>;
  let launchedCampaignId: string;
  const suffix = randomUUID().slice(0, 6);
  const tagName = `vip${suffix}`;

  const call = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  /** Asks the assistant and answers the request as the worker would. */
  const ask = async (who: SignedInAgent, prompt: string) => {
    const queued = await call(who, 'post', '/assistant/requests', { prompt });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    expect(queued.body).toMatchObject({ status: 'QUEUED', prompt, drafts: [], actions: [] });
    await ctx.app.get(AssistantRunner).run(queued.body.id);
    const answered = await call(who, 'get', `/assistant/requests/${queued.body.id}`);
    expect(answered.status).toBe(200);
    return answered.body;
  };
  const assistantRequests = async () => (await call(admin, 'get', '/ai-usage')).body.assistantRequests as number;
  const campaignState = async (id: string) => (await ctx.prisma.campaign.findUniqueOrThrow({ where: { id }, select: { state: true } })).state;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    agentMember = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
    template = await seedTemplate(ctx, number.wabaId, { name: `weekend_${suffix}` });
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const contacts = await Promise.all([1, 2, 3].map((i) => seedContact(ctx, uaePhone(), { name: `VIP ${i}` })));
    await ctx.prisma.contactTag.createMany({ data: contacts.map((c) => ({ contactId: c.id, tagId: tag.id })) });
    original = (await call(admin, 'get', '/ai-settings')).body;
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    await call(admin, 'put', '/ai-settings', original);
    restoreNetwork();
    await ctx.close();
  });

  it('drafts a template with the button, streams the turn, and submits nothing to Meta', async () => {
    const seen: unknown[] = [];
    claudeStream(
      [
        {
          type: 'tool_use',
          name: 'draft_template',
          input: {
            name: `weekend_sale_${suffix}`,
            language: 'en',
            category: 'MARKETING',
            headerText: null,
            body: 'Our weekend sale is on: 20% off everything.',
            bodyExamples: [],
            footer: null,
            buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/sale', phoneNumber: null }],
          },
        },
      ],
      seen,
    );
    claudeStream([{ type: 'text', text: 'I drafted the weekend sale template with a Shop now button. Review it and submit it from the template editor.' }], seen);
    const before = await assistantRequests();

    const request = await ask(manager, 'Write a template for our weekend sale with a "Shop now" button');
    expect(request).toMatchObject({ status: 'DONE', errorCode: null, reply: expect.stringContaining('Shop now'), actions: [] });
    expect(request.drafts).toEqual([{ kind: 'TEMPLATE', id: expect.any(String), name: `weekend_sale_${suffix}` }]);
    const row = await ctx.prisma.template.findUniqueOrThrow({ where: { id: request.drafts[0].id } });
    expect(row).toMatchObject({ status: 'DRAFT', metaTemplateId: null, category: 'MARKETING', language: 'en' });
    expect(JSON.stringify(row.components)).toContain('Shop now');
    // Every Claude call was used, and the useNockLocalOnly guard would have failed any call to Meta.
    expect(nock.isDone()).toBe(true);
    expect(toolResultsOf(seen[1])).toEqual([{ text: expect.stringContaining('not submitted to Meta'), isError: false }]);

    // The turn follows the contract: streamed, effort medium, the cached system prompt, the six tools.
    const first = seen[0] as { model: string; stream: boolean; max_tokens: number; output_config: { effort: string }; system: Array<{ cache_control?: unknown }>; tools: Array<{ name: string; strict?: boolean }> };
    expect(first).toMatchObject({ model: 'claude-opus-5-5', stream: true, max_tokens: 32000, output_config: { effort: 'medium' } });
    expect(first.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.tools.map((t) => t.name)).toEqual(['draft_campaign', 'draft_flow', 'draft_template', 'propose_campaign_send', 'propose_delete', 'report_summary']);
    expect(first.tools.every((t) => t.strict === true)).toBe(true);

    // Counted once, apart from AI replies; the draft opens in the template editor for review.
    expect(await assistantRequests()).toBe(before + 1);
    // It opens under its own name, so submitting it from the editor replaces the draft.
    const prefill = await call(manager, 'post', `/templates/${row.id}/duplicate`);
    expect(prefill.status).toBeLessThan(300);
    expect(prefill.body.name).toBe(`weekend_sale_${suffix}`);
    expect(JSON.stringify(prefill.body.buttons)).toContain('Shop now');
    const meta = nock(META_BASE).post(`/${META_VERSION}/${row.wabaId}/message_templates`).reply(200, { id: `mt-${suffix}`, status: 'PENDING', category: 'MARKETING' });
    const submitted = await call(manager, 'post', '/templates', prefill.body);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(meta.isDone()).toBe(true);
    expect(submitted.body.id).toBe(row.id);
    expect(await ctx.prisma.template.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'PENDING', metaTemplateId: `mt-${suffix}` });
  });

  it('drafts a flow that stays unpublished and passes the 003 publish checks', async () => {
    claudeStream([{ type: 'tool_use', name: 'draft_flow', input: { name: `Name and city ${suffix}`, graphJson: JSON.stringify(NAME_AND_CITY) } }]);
    claudeStream([{ type: 'text', text: 'The flow draft is ready for review.' }]);
    const request = await ask(manager, 'Build a flow that asks for name and city and then hands over');
    expect(request.drafts).toEqual([{ kind: 'FLOW', id: expect.any(String), name: `Name and city ${suffix}` }]);
    const flow = await ctx.prisma.flow.findUniqueOrThrow({ where: { id: request.drafts[0].id } });
    expect(flow).toMatchObject({ status: 'DRAFT', publishedVersionId: null });
    expect(validateForPublish(FlowGraphSchema.parse(flow.draft))).toEqual([]);
  });

  it('drafts a campaign that is not scheduled, and sends it only after the member confirms the preview', async () => {
    claudeStream([
      {
        type: 'tool_use',
        name: 'draft_campaign',
        input: {
          name: `VIP weekend ${suffix}`,
          templateId: template.id,
          numberId: number.id,
          allOptedIn: false,
          tags: [tagName],
          rules: [],
          variables: [{ variable: 'BODY.1', source: 'field', key: 'name', value: null, fallback: 'there' }],
        },
      },
    ]);
    claudeStream([{ type: 'text', text: 'The campaign draft is ready.' }]);
    const drafted = await ask(manager, `Draft a campaign of ${template.name} to VIP contacts`);
    const campaignId = drafted.drafts[0].id as string;
    expect(drafted.drafts).toEqual([{ kind: 'CAMPAIGN', id: expect.any(String), name: `VIP weekend ${suffix}` }]);
    expect(await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ state: 'DRAFT', scheduledAt: null });

    claudeStream([{ type: 'tool_use', name: 'propose_campaign_send', input: { campaignId, sendAt: null } }]);
    claudeStream([{ type: 'text', text: 'Confirm the preview to send it.' }]);
    const proposed = await ask(manager, 'Send it now');
    expect(proposed.actions).toHaveLength(1);
    const action = proposed.actions[0];
    expect(action).toMatchObject({
      kind: 'SEND_CAMPAIGN',
      status: 'PENDING',
      result: null,
      preview: { campaign: { id: campaignId }, template: { id: template.id }, number: { id: number.id }, recipients: 3 },
    });
    expect(action.preview).toHaveProperty('estimatedCostUsd');
    expect(Date.parse(action.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    // Nothing is sent until the member confirms.
    expect(await campaignState(campaignId)).toBe('DRAFT');
    expect(await ctx.prisma.message.count({ where: { campaignId } })).toBe(0);

    // Only the member who asked may confirm it.
    expect((await call(admin, 'post', `/assistant/actions/${action.id}/confirm`)).status).toBe(404);
    const confirmed = await call(manager, 'post', `/assistant/actions/${action.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ id: action.id, status: 'CONFIRMED', result: { campaignId } });
    expect(await campaignState(campaignId)).toBe('RUNNING');
    expect(await ctx.prisma.message.count({ where: { campaignId, status: 'PENDING' } })).toBe(3);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'ai.assistant_action_confirmed', targetId: action.id } });
    expect(audit).toMatchObject({ actorUserId: manager.userId, targetType: 'assistant_action' });
    // The launch itself ran as the member, through the campaign service.
    expect(await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'campaign.launched', targetId: campaignId } })).toMatchObject({ actorUserId: manager.userId });
    const again = await call(manager, 'post', `/assistant/actions/${action.id}/confirm`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ACTION_DECIDED');
    launchedCampaignId = campaignId;
  });

  it('answers report questions with the figures of the campaign reports', async () => {
    const { defaultTimezone } = await ctx.prisma.settings.findUniqueOrThrow({ where: { id: 1 }, select: { defaultTimezone: true } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: defaultTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const seen: unknown[] = [];
    claudeStream([{ type: 'tool_use', name: 'report_summary', input: { from: today, to: today } }], seen);
    claudeStream([{ type: 'text', text: 'Here is how today went.' }], seen);
    const request = await ask(manager, "How did today's campaigns do?");
    expect(request.status).toBe('DONE');
    const [result] = toolResultsOf(seen[1]);
    expect(result!.isError).toBe(false);
    const summary = JSON.parse(result!.text) as { campaigns: Array<{ id: string; totals: unknown; deliveryRate: number; readRate: number; estimatedCostUsd: number }> };
    expect(summary.campaigns.map((c) => c.id)).toContain(launchedCampaignId);
    const reports = ctx.app.get(ReportsService);
    for (const campaign of summary.campaigns) {
      const report = await reports.report(campaign.id);
      expect(campaign).toMatchObject({ totals: report.totals, deliveryRate: report.deliveryRate, readRate: report.readRate, estimatedCostUsd: report.estimatedCostUsd });
    }
  });

  it('cancels a preview; an expired one or one the role no longer allows cannot be confirmed', async () => {
    const queued = (await call(manager, 'post', '/assistant/requests', { prompt: 'previews for the test' })).body;
    const make = (kind: 'SEND_CAMPAIGN' | 'DELETE_CONTACTS', expiresAt: Date) =>
      ctx.prisma.assistantAction.create({ data: { requestId: queued.id, userId: manager.userId, kind, params: { campaignId: launchedCampaignId, contactIds: [] }, preview: { note: 'test' }, expiresAt } });
    const soon = new Date(Date.now() + 10 * 60_000);

    const toCancel = await make('SEND_CAMPAIGN', soon);
    const cancelled = await call(manager, 'post', `/assistant/actions/${toCancel.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await call(manager, 'post', `/assistant/actions/${toCancel.id}/confirm`)).body.code).toBe('ACTION_DECIDED');
    expect((await call(manager, 'post', `/assistant/actions/${toCancel.id}/cancel`)).status).toBe(409);

    const old = await make('SEND_CAMPAIGN', new Date(Date.now() - 60_000));
    const expired = await call(manager, 'post', `/assistant/actions/${old.id}/confirm`);
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('ACTION_EXPIRED');
    expect((await ctx.prisma.assistantAction.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('EXPIRED');

    // Deleting contacts needs contacts.delete (admins only), checked again on confirm.
    const forbidden = await make('DELETE_CONTACTS', soon);
    const refused = await call(manager, 'post', `/assistant/actions/${forbidden.id}/confirm`);
    expect(refused.status).toBe(403);
    expect((await ctx.prisma.assistantAction.findUniqueOrThrow({ where: { id: forbidden.id } })).status).toBe('PENDING');
  });

  it('refuses what the role does not allow and says why', async () => {
    const seen: unknown[] = [];
    claudeStream([{ type: 'text', text: 'I cannot change the AI reply limit: only an admin can, on the AI usage page.' }], seen);
    const before = (await ctx.prisma.settings.findUniqueOrThrow({ where: { id: 1 }, select: { aiReplyLimit: true } })).aiReplyLimit;
    const limit = await ask(manager, 'Raise the AI reply limit to 5000');
    expect(limit).toMatchObject({ status: 'DONE', reply: expect.stringContaining('only an admin'), drafts: [], actions: [] });
    expect((await ctx.prisma.settings.findUniqueOrThrow({ where: { id: 1 }, select: { aiReplyLimit: true } })).aiReplyLimit).toBe(before);
    // The model is told the member's role and permissions, and that settings are out of reach.
    const body = seen[0] as { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }> };
    expect(body.system[0]!.text).toContain('only an admin can change the AI reply limit');
    const workspace = body.messages[0]!.content[0]!.text;
    expect(workspace).toContain('"role":"MANAGER"');
    expect(workspace).not.toContain('"ai.usage"');
    expect(workspace).not.toMatch(/\+971/);

    const deletion: unknown[] = [];
    claudeStream([{ type: 'tool_use', name: 'propose_delete', input: { kind: 'CONTACTS', phones: [], withTag: tagName, tags: [] } }], deletion);
    claudeStream([{ type: 'text', text: 'Only an admin can delete contacts.' }], deletion);
    const contactsBefore = await ctx.prisma.contactTag.count({ where: { tag: { name: tagName } } });
    const refused = await ask(manager, 'Delete all VIP contacts');
    expect(refused).toMatchObject({ status: 'DONE', errorCode: 'REFUSED', drafts: [], actions: [] });
    expect(toolResultsOf(deletion[1])).toEqual([{ text: expect.stringContaining('Not allowed'), isError: true }]);
    expect(await ctx.prisma.contactTag.count({ where: { tag: { name: tagName } } })).toBe(contactsBefore);
  });

  it('stops at the monthly assistant limit with 429 LIMIT_REACHED', async () => {
    const used = await assistantRequests();
    expect((await call(admin, 'put', '/ai-settings', { ...original, assistantLimit: used })).status).toBe(200);
    const res = await call(manager, 'post', '/assistant/requests', { prompt: 'one more please' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('LIMIT_REACHED');
    expect((await call(admin, 'put', '/ai-settings', original)).status).toBe(200);
  });

  it('marks the request failed when the AI service fails, without counting it', async () => {
    nock(CLAUDE).post('/v1/messages').query(true).reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const before = await assistantRequests();
    const request = await ask(manager, 'Write a template for Friday');
    expect(request).toMatchObject({ status: 'FAILED', errorCode: 'AI_UNAVAILABLE', reply: null });
    expect(request.finishedAt).not.toBeNull();
    expect(await assistantRequests()).toBe(before);
  });

  it('shows members only their own requests; agents cannot use the assistant', async () => {
    const mine = (await call(manager, 'get', '/assistant/requests')).body as Array<{ id: string; prompt: string }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.map((r) => r.prompt)).toContain('Raise the AI reply limit to 5000');
    const theirs = (await call(admin, 'get', '/assistant/requests')).body as Array<{ id: string }>;
    expect(theirs.map((r) => r.id)).not.toContain(mine[0]!.id);
    expect((await call(admin, 'get', `/assistant/requests/${mine[0]!.id}`)).status).toBe(404);
    expect((await call(agentMember, 'post', '/assistant/requests', { prompt: 'hello' })).status).toBe(403);
    expect((await call(agentMember, 'get', '/assistant/requests')).status).toBe(403);
    expect((await call(manager, 'post', '/assistant/requests', { prompt: '' })).status).toBe(422);
  });
});
