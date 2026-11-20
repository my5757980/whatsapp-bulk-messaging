import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { flowTimerJobId } from '../../src/modules/flows/steps/flow-jobs.js';
import { FlowTimerProcessor } from '../../src/modules/flows/steps/timer.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T047: US4 logic steps through webhooks - tags and attributes change on the contact with
// journey entries by the flow, a working-hours branch, a delay through its timer, a jump into a
// published flow, and the publish checks for jumps (FR-011–FR-016, FR-033).
describe('Chatbot flows: tags, attributes, conditions, delays and jumps (US4)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let manager: SignedInAgent;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const tags = { vip: '', fresh: '' };
  const keys = { city: `city_${suffix}`, visits: `visits_${suffix}` };

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, body: string) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const texts = async (conversationId: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((i) => i.text);
  const keyword = (name: string) => [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`${name}${suffix}`], canInterrupt: false }];
  /** Creates a flow with this draft; publishes it unless asked not to. Returns the flow id and the publish response. */
  const flow = async (name: string, graph: object, publish = true) => {
    const created = await api('post', '/flows', { name: `${name} ${suffix}` });
    expect((await api('put', `/flows/${created.body.id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    const published = publish ? await api('post', `/flows/${created.body.id}/publish`) : null;
    return { id: created.body.id as string, published };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    tags.vip = (await ctx.prisma.tag.create({ data: { name: `vip-${suffix}` } })).id;
    tags.fresh = (await ctx.prisma.tag.create({ data: { name: `new-${suffix}` } })).id;
    await ctx.prisma.attributeDefinition.createMany({
      data: [
        { key: keys.city, label: 'City', type: 'TEXT' },
        { key: keys.visits, label: 'Visits', type: 'NUMBER' },
      ],
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('changes tags and attributes with journey entries by the flow, and a condition sees the changes', async () => {
    const { published } = await flow('Profile', {
      version: 1,
      start: 'tag',
      triggers: keyword('profile'),
      steps: [
        { id: 'tag', type: 'tags', add: [tags.vip], remove: [tags.fresh], next: 'set' },
        { id: 'set', type: 'attributes', set: [{ key: keys.city, value: { source: 'static', value: 'Ajman' } }, { key: keys.visits, value: { source: 'static', value: '3' } }], next: 'check' },
        {
          id: 'check',
          type: 'condition',
          rules: [
            { subject: { kind: 'tag', tagId: tags.vip }, op: 'is_present' },
            { subject: { kind: 'attribute', key: keys.city }, op: 'equals', value: 'ajman' },
          ],
          yes: 'vip',
          no: 'other',
        },
        { id: 'vip', type: 'message', text: 'Welcome back, VIP from Ajman.', next: null },
        { id: 'other', type: 'message', text: 'Welcome.', next: null },
      ],
    });
    expect(published?.status, JSON.stringify(published?.body)).toBe(200);

    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tags.fresh } });
    const chat = await inbound(phone, `profile${suffix}`);
    expect(await texts(chat.id)).toEqual(['Welcome back, VIP from Ajman.']);

    const after = await ctx.prisma.contact.findUniqueOrThrow({ where: { id: contact.id }, include: { tags: true } });
    expect(after.tags.map((t) => t.tagId)).toEqual([tags.vip]);
    expect(after.attributes).toMatchObject({ [keys.city]: 'Ajman', [keys.visits]: 3 });
    const journey = await ctx.prisma.conversationEvent.findMany({ where: { conversationId: chat.id, type: { in: ['TAG_ADDED', 'TAG_REMOVED', 'ATTRIBUTE_CHANGED'] } }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    expect(journey.map((e) => [e.type, e.actorType])).toEqual([
      ['TAG_ADDED', 'FLOW'],
      ['TAG_REMOVED', 'FLOW'],
      ['ATTRIBUTE_CHANGED', 'FLOW'],
      ['ATTRIBUTE_CHANGED', 'FLOW'],
    ]);
    expect(journey[0]!.data).toMatchObject({ tag: `vip-${suffix}`, flowName: `Profile ${suffix}` });
  });

  it('branches on the 002 working hours', async () => {
    await flow('Hours', {
      version: 1,
      start: 'open',
      triggers: keyword('hours'),
      steps: [
        { id: 'open', type: 'condition', rules: [{ subject: { kind: 'workingHours' }, op: 'inside' }], yes: 'yes', no: 'no' },
        { id: 'yes', type: 'message', text: 'We are open now.', next: null },
        { id: 'no', type: 'message', text: 'We are closed now.', next: null },
      ],
    });
    const settings = await ctx.prisma.liveChatSettings.findUniqueOrThrow({ where: { id: 1 } });
    const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '24:00']]]));
    const closed = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]));
    try {
      await ctx.prisma.liveChatSettings.update({ where: { id: 1 }, data: { workingHours: allDay, timezone: 'Asia/Dubai' } });
      const open = await inbound(uaePhone(), `hours${suffix}`);
      expect(await texts(open.id)).toEqual(['We are open now.']);

      await ctx.prisma.liveChatSettings.update({ where: { id: 1 }, data: { workingHours: closed } });
      const shut = await inbound(uaePhone(), `hours${suffix}`);
      expect(await texts(shut.id)).toEqual(['We are closed now.']);
    } finally {
      await ctx.prisma.liveChatSettings.update({ where: { id: 1 }, data: { workingHours: settings.workingHours as Prisma.InputJsonValue, timezone: settings.timezone } });
    }
  });

  it('waits on a delay until its timer runs', async () => {
    await flow('Wait', {
      version: 1,
      start: 'a',
      triggers: keyword('wait'),
      steps: [
        { id: 'a', type: 'message', text: 'One moment, please.', next: 'pause' },
        { id: 'pause', type: 'delay', seconds: 5, next: 'b' },
        { id: 'b', type: 'message', text: 'Here is your answer.', next: null },
      ],
    });
    const chat = await inbound(uaePhone(), `wait${suffix}`);
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(session).toMatchObject({ status: 'RUNNING', wait: 'DELAY', currentStepId: 'pause' });
    const timer = { sessionId: session.id, token: session.waitToken };
    expect((await ctx.app.get(QueueRegistry).get(QUEUES.FLOWS).getJob(flowTimerJobId(timer)))?.opts.delay).toBe(5_000);
    expect(await texts(chat.id)).toEqual(['One moment, please.']);

    await ctx.app.get(FlowTimerProcessor).run(timer);
    expect(await texts(chat.id)).toEqual(['One moment, please.', 'Here is your answer.']);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });
  });

  it('jumps into a published flow, which continues in the same chat', async () => {
    const menu = await flow('Main menu', {
      version: 1,
      start: 'menu',
      triggers: keyword('menu'),
      steps: [{ id: 'menu', type: 'buttons', text: 'Main menu: what do you need?', buttons: [{ key: 'hours', title: 'Opening hours', next: 'bye' }] }, { id: 'bye', type: 'end' }],
    });
    const router = await flow('Router', {
      version: 1,
      start: 'a',
      triggers: keyword('router'),
      steps: [
        { id: 'a', type: 'message', text: 'Taking you to the main menu.', next: 'go' },
        { id: 'go', type: 'jump', flowId: menu.id },
      ],
    });
    expect(router.published?.status, JSON.stringify(router.published?.body)).toBe(200);

    const chat = await inbound(uaePhone(), `router${suffix}`);
    expect(await texts(chat.id)).toEqual(['Taking you to the main menu.', 'Main menu: what do you need?']);
    // Both sessions are written in one transaction, so they are told apart by flow, not by time.
    const parent = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id, flowId: router.id } });
    const child = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id, flowId: menu.id } });
    expect(parent).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });
    expect(child).toMatchObject({ status: 'RUNNING', startedBy: 'JUMP', parentSessionId: parent.id, currentStepId: 'menu' });
    const steps = await ctx.prisma.flowSessionStep.findMany({ where: { sessionId: parent.id }, orderBy: { id: 'asc' } });
    expect(steps.map((s) => [s.stepId, s.branch])).toEqual([
      ['a', 'next'],
      ['go', 'jumped'],
    ]);
  });

  it('refuses jumps to unpublished flows and loops of jumps that never wait', async () => {
    const draftOnly = await flow('Draft target', { version: 1, start: 'a', triggers: [], steps: [{ id: 'a', type: 'message', text: 'Hi', next: null }] }, false);
    const refused = await flow('Jumps to a draft', { version: 1, start: 'go', triggers: keyword('todraft'), steps: [{ id: 'go', type: 'jump', flowId: draftOnly.id }] });
    expect(refused.published?.status).toBe(422);
    expect(refused.published?.body.problems.map((p: { code: string; stepId: string }) => `${p.code}:${p.stepId}`)).toEqual(['JUMP_TARGET_NOT_PUBLISHED:go']);

    const b = await flow('Loop B', { version: 1, start: 'a', triggers: keyword('loopb'), steps: [{ id: 'a', type: 'message', text: 'B', next: null }] });
    const a = await flow('Loop A', { version: 1, start: 'a', triggers: keyword('loopa'), steps: [{ id: 'a', type: 'message', text: 'A', next: 'go' }, { id: 'go', type: 'jump', flowId: b.id }] });
    expect(a.published?.status).toBe(200);
    // B now jumps back to A without a question on the way.
    await api('put', `/flows/${b.id}/draft`, { graph: { version: 1, start: 'a', triggers: keyword('loopb'), steps: [{ id: 'a', type: 'message', text: 'B', next: 'go' }, { id: 'go', type: 'jump', flowId: a.id }] }, draftRevision: 1 });
    const looping = await api('post', `/flows/${b.id}/publish`);
    expect(looping.status).toBe(422);
    expect(looping.body.problems.map((p: { code: string; stepId: string }) => `${p.code}:${p.stepId}`)).toEqual(['LOOP_WITHOUT_WAIT:go']);
  });
});
