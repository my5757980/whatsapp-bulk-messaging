import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T018: US1 - build a flow, publish it (refusing broken drafts), and run it from a keyword with
// reply buttons, through the 002 live chat pipeline (FR-001–FR-008, FR-019, FR-030).
describe('Chatbot flows: build, publish and run (US1)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let manager: SignedInAgent;
  let mediaAssetId: string;

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, message: Record<string, unknown>) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  };
  const text = (body: string) => ({ type: 'text', text: { body } });
  const tap = (id: string, title: string) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const flowItems = (conversationId: string) =>
    ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: { occurredAt: 'asc' } });

  type TestGraph = { version: 1; start: string; triggers: Array<{ id: string; kind: string; match: string; phrases: string[]; canInterrupt: boolean }>; steps: Array<Record<string, unknown>> };
  const graph = (greeting = 'We open 9–6, Monday to Saturday. Anything else?'): TestGraph => ({
    version: 1,
    start: 'hours',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'CONTAINS', phrases: [`hours${randomUUID().slice(0, 4)}`], canInterrupt: false }],
    steps: [
      { id: 'hours', type: 'buttons', position: { x: 0, y: 0 }, text: greeting, buttons: [{ key: 'loc', title: 'Location', next: 'where' }, { key: 'human', title: 'Talk to us', next: 'agent' }] },
      { id: 'where', type: 'message', position: { x: 0, y: 200 }, text: 'Find us at the marina.', mediaAssetId },
      { id: 'agent', type: 'end', position: { x: 200, y: 200 } },
    ],
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    mediaAssetId = (
      await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/${randomUUID()}.jpg`, mimeType: 'image/jpeg', sizeBytes: 2048, purpose: 'LIBRARY', displayName: 'map.jpg' } })
    ).id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates flows, saves drafts with conflicts, refuses broken drafts and publishes', async () => {
    const created = await api('post', '/flows', { name: `Opening hours ${randomUUID().slice(0, 6)}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', draftRevision: 0, publishedVersion: null, graph: { version: 1, steps: [] } });
    expect((await api('post', '/flows', { name: created.body.name })).status).toBe(409);

    // A draft with an unconnected button and a message without text saves, with problems listed.
    const broken = graph();
    broken.steps[0]!.buttons = [{ key: 'loc', title: 'Location', next: null }];
    broken.steps[1]!.text = '';
    broken.steps[1]!.mediaAssetId = null;
    const saved = await api('put', `/flows/${created.body.id}/draft`, { graph: broken, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.draftRevision).toBe(1);
    expect(saved.body.problems.map((p: { code: string }) => p.code).sort()).toEqual(['BRANCH_NOT_CONNECTED', 'UNREACHABLE_STEP', 'UNREACHABLE_STEP']);
    expect((await api('put', `/flows/${created.body.id}/draft`, { graph: broken, draftRevision: 0 })).status).toBe(409);
    expect((await api('put', `/flows/${created.body.id}/draft`, { graph: { ...broken, steps: [...broken.steps, { id: 'x', type: 'buttons', buttons: [1, 2, 3, 4].map((n) => ({ key: `b${n}`, title: 'B', next: null })) }] }, draftRevision: 1 })).status).toBe(422);

    const blocked = await api('post', `/flows/${created.body.id}/publish`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');
    expect(blocked.body.problems.length).toBeGreaterThan(0);

    const good = graph();
    expect((await api('put', `/flows/${created.body.id}/draft`, { graph: good, draftRevision: 1 })).status).toBe(200);
    const published = await api('post', `/flows/${created.body.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', publishedVersion: { number: 1 }, hasUnpublishedChanges: false });
    const triggers = await ctx.prisma.flowTrigger.findMany({ where: { flowId: created.body.id } });
    expect(triggers).toMatchObject([{ kind: 'KEYWORD', match: 'CONTAINS', phrase: good.triggers[0]!.phrases[0] }]);
    expect((await api('delete', `/flows/${created.body.id}`)).status).toBe(409);
  });

  it('runs a published flow from a keyword with reply buttons and shows it in live chat', async () => {
    const created = await api('post', '/flows', { name: `Hours ${randomUUID().slice(0, 6)}` });
    const g = graph();
    await api('put', `/flows/${created.body.id}/draft`, { graph: g, draftRevision: 0 });
    expect((await api('post', `/flows/${created.body.id}/publish`)).status).toBe(200);
    const keyword = g.triggers[0]!.phrases[0]!;

    const phone = uaePhone();
    const chat = await inbound(phone, text(`What are your ${keyword.toUpperCase()}?`));
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(session).toMatchObject({ status: 'RUNNING', wait: 'INPUT', currentStepId: 'hours', startedBy: 'TRIGGER', isTest: false });

    let items = await flowItems(chat.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType: 'BUTTONS', text: String(g.steps[0]!.text), status: 'QUEUED' });
    const payload = items[0]!.payload as { flow: { flowName: string }; buttons: Array<{ id: string; title: string }> };
    expect(payload.flow.flowName).toBe(created.body.name);
    expect(payload.buttons.map((b) => b.title)).toEqual(['Location', 'Talk to us']);
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${items[0]!.id}`)).toBeTruthy();

    await inbound(phone, tap(payload.buttons[0]!.id, 'Location'));
    items = await flowItems(chat.id);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ contentType: 'IMAGE', mediaAssetId, text: 'Find us at the marina.' });
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });
    const steps = await ctx.prisma.flowSessionStep.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' } });
    expect(steps.map((s) => [s.stepId, s.branch])).toEqual([
      ['hours', 'loc'],
      ['where', 'next'],
    ]);
    const journey = await ctx.prisma.conversationEvent.findMany({ where: { conversationId: chat.id, type: { in: ['FLOW_STARTED', 'FLOW_ENDED'] } }, orderBy: { occurredAt: 'asc' } });
    expect(journey.map((e) => e.type)).toEqual(['FLOW_STARTED', 'FLOW_ENDED']);
  });

  it('keeps customers on the published version until the draft is published, and unpublish stops new sessions', async () => {
    const created = await api('post', '/flows', { name: `Versions ${randomUUID().slice(0, 6)}` });
    const g = graph('Version one');
    await api('put', `/flows/${created.body.id}/draft`, { graph: g, draftRevision: 0 });
    await api('post', `/flows/${created.body.id}/publish`);
    const changed = { ...g, steps: [{ ...g.steps[0]!, text: 'Version two' }, ...g.steps.slice(1)] };
    const saved = await api('put', `/flows/${created.body.id}/draft`, { graph: changed, draftRevision: 1 });
    expect(saved.status).toBe(200);
    expect((await api('get', `/flows/${created.body.id}`)).body.hasUnpublishedChanges).toBe(true);

    const keyword = g.triggers[0]!.phrases[0]!;
    const first = await inbound(uaePhone(), text(keyword));
    expect((await flowItems(first.id))[0]!.text).toBe('Version one');

    expect((await api('post', `/flows/${created.body.id}/unpublish`)).status).toBe(200);
    expect(await ctx.prisma.flowTrigger.count({ where: { flowId: created.body.id } })).toBe(0);
    const second = await inbound(uaePhone(), text(keyword));
    expect(await flowItems(second.id)).toHaveLength(0);
    // The running session ends at its next step.
    await inbound((await ctx.prisma.contact.findUniqueOrThrow({ where: { id: first.contactId! } })).phoneE164, text('Location'));
    expect(await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: first.id } })).toMatchObject({ status: 'ENDED', result: 'FLOW_UNPUBLISHED' });
  });
});
