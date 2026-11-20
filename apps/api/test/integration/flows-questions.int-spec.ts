import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { FlowExpiryProcessor } from '../../src/modules/flows/steps/expiry.processor.js';
import { flowTimerJobId } from '../../src/modules/flows/steps/flow-jobs.js';
import { FlowTimerProcessor } from '../../src/modules/flows/steps/timer.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T030: US2 - "Book a visit" through webhooks: questions with validation and retries, a list,
// answers saved to contact attributes with journey entries by the flow, publish checks for those
// attributes, the timeout timer (and a stale one) and the 24-hour expiry (FR-009, FR-010, FR-032).
describe('Chatbot flows: questions, lists and answers (US2)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let manager: SignedInAgent;
  let flowId: string;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const keys = { name: `full_name_${suffix}`, date: `visit_date_${suffix}`, email: `email_${suffix}`, branch: `branch_${suffix}`, guests: `guests_${suffix}` };
  const keyword = `visit${suffix}`;
  const nextYear = new Date().getUTCFullYear() + 1;
  const HOUR = 3_600_000;

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
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
  const listTap = (id: string, title: string) => ({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });
  const flowItems = (conversationId: string) =>
    ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const sessionOf = (id: string) => ctx.prisma.flowSession.findUniqueOrThrow({ where: { id } });

  type TestGraph = { version: 1; start: string; triggers: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> };
  const bookAVisit = (phrase = keyword): TestGraph => ({
    version: 1,
    start: 'name',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [phrase], canInterrupt: false }],
    steps: [
      { id: 'name', type: 'question', text: 'What is your full name?', answer: { kind: 'text', minLength: 2 }, answerName: 'full_name', saveTo: { attributeKey: keys.name }, retryText: 'Please type your full name.', next: 'date' },
      {
        id: 'date',
        type: 'question',
        text: 'Which day would you like to visit?',
        answer: { kind: 'date', earliest: 'today' },
        answerName: 'visit_date',
        saveTo: { attributeKey: keys.date },
        retries: 2,
        retryText: 'Please send a date from today on, like 25/12.',
        timeoutMinutes: 30,
        next: 'email',
        onInvalid: 'person',
        onTimeout: 'later',
      },
      { id: 'email', type: 'question', text: 'Your email for the confirmation?', answer: { kind: 'email' }, answerName: 'email', saveTo: { attributeKey: keys.email }, retryText: 'That does not look like an email.', next: 'branch' },
      {
        id: 'branch',
        type: 'list',
        text: 'Which branch?',
        buttonLabel: 'Branches',
        sections: [{ title: 'UAE', rows: [{ key: 'dxb', title: 'Dubai' }, { key: 'shj', title: 'Sharjah' }] }],
        sharedNext: 'thanks',
        answerName: 'branch',
        saveTo: { attributeKey: keys.branch },
      },
      { id: 'thanks', type: 'message', text: `Thanks {attr:${keys.name}}, see you on {answer:visit_date} at {answer:branch}.`, next: null },
      { id: 'person', type: 'message', text: 'A person will help you with the date.', next: null },
      { id: 'later', type: 'message', text: 'No problem, write visit any time.', next: null },
    ],
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    await ctx.prisma.attributeDefinition.createMany({
      data: [
        { key: keys.name, label: 'Full name', type: 'TEXT' },
        { key: keys.date, label: 'Visit date', type: 'DATE' },
        { key: keys.email, label: 'Email', type: 'TEXT' },
        { key: keys.branch, label: 'Branch', type: 'TEXT' },
        { key: keys.guests, label: 'Guests', type: 'NUMBER' },
      ],
    });
    const created = await api('post', '/flows', { name: `Book a visit ${suffix}` });
    flowId = created.body.id;
    expect((await api('put', `/flows/${flowId}/draft`, { graph: bookAVisit(), draftRevision: 0 })).status).toBe(200);
    const published = await api('post', `/flows/${flowId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses to publish answers saved to a missing attribute or one of another type', async () => {
    const created = await api('post', '/flows', { name: `Book a visit ${suffix} (broken)` });
    const broken = bookAVisit(`${keyword}x`);
    broken.steps[0] = { ...broken.steps[0], saveTo: { attributeKey: `missing_${suffix}` } };
    broken.steps[1] = { ...broken.steps[1], saveTo: { attributeKey: keys.guests } };
    broken.steps[3] = { ...broken.steps[3], answerName: 'full_name' };
    await api('put', `/flows/${created.body.id}/draft`, { graph: broken, draftRevision: 0 });
    const blocked = await api('post', `/flows/${created.body.id}/publish`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.problems.map((p: { code: string; stepId: string }) => `${p.code}:${p.stepId}`).sort()).toEqual([
      'ATTRIBUTE_TYPE:date',
      'DUPLICATE_ANSWER_NAME:branch',
      'UNKNOWN_ATTRIBUTE:name',
    ]);
  });

  it('runs "Book a visit": two wrong dates get the retry prompt, answers are saved with journey entries', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text(keyword));
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(session).toMatchObject({ status: 'RUNNING', currentStepId: 'name', wait: 'INPUT' });

    await inbound(phone, text('Sara Khan'));
    await inbound(phone, text('yesterday'));
    await inbound(phone, text('hello'));
    expect(await sessionOf(session.id)).toMatchObject({ currentStepId: 'date', retries: 2 });
    let contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect((contact.attributes as Record<string, unknown>)[keys.date]).toBeUndefined();

    await inbound(phone, text(`25/12/${nextYear}`));
    await inbound(phone, text('Sara.Khan@Example.com'));
    let items = await flowItems(chat.id);
    expect(items.map((i) => i.text)).toEqual([
      'What is your full name?',
      'Which day would you like to visit?',
      'Please send a date from today on, like 25/12.',
      'Please send a date from today on, like 25/12.',
      'Your email for the confirmation?',
      'Which branch?',
    ]);
    const list = items.at(-1)!;
    expect(list.contentType).toBe('LIST');
    const rows = (list.payload as { sections: Array<{ rows: Array<{ id: string; title: string }> }> }).sections[0]!.rows;
    expect(rows.map((r) => r.title)).toEqual(['Dubai', 'Sharjah']);

    await inbound(phone, listTap(rows[1]!.id, 'Sharjah'));
    items = await flowItems(chat.id);
    expect(items.at(-1)!.text).toBe(`Thanks Sara Khan, see you on ${nextYear}-12-25 at Sharjah.`);
    expect(await sessionOf(session.id)).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });

    contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(contact.attributes).toMatchObject({ [keys.name]: 'Sara Khan', [keys.date]: `${nextYear}-12-25`, [keys.email]: 'sara.khan@example.com', [keys.branch]: 'Sharjah' });
    const changes = await ctx.prisma.conversationEvent.findMany({ where: { conversationId: chat.id, type: 'ATTRIBUTE_CHANGED' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    expect(changes.map((e) => [e.actorType, (e.data as { key: string }).key])).toEqual([
      ['FLOW', keys.name],
      ['FLOW', keys.date],
      ['FLOW', keys.email],
      ['FLOW', keys.branch],
    ]);
    expect(changes[0]!.data).toMatchObject({ from: null, to: 'Sara Khan', flowId });

    // Live chat's journey shows the changes as made by the flow (002 FR-033).
    const journey = await api('get', `/inbox/conversations/${chat.id}/journey`);
    expect(journey.status).toBe(200);
    const byFlow = (journey.body as Array<{ type: string; actor: { type: string; name: string | null } }>).filter((e) => e.type === 'ATTRIBUTE_CHANGED');
    expect(byFlow).toHaveLength(4);
    expect(byFlow.every((e) => e.actor.type === 'FLOW' && e.actor.name === `Book a visit ${suffix}`)).toBe(true);
  });

  it('runs the timeout branch from the timer job and ignores an older timer', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text(keyword));
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    const flows = ctx.app.get(QueueRegistry).get(QUEUES.FLOWS);
    const nameTimer = { sessionId: session.id, token: session.waitToken };
    const queued = await flows.getJob(flowTimerJobId(nameTimer));
    expect(queued?.data).toEqual(nameTimer);
    expect(queued?.opts.delay).toBe(60 * 60_000);

    await inbound(phone, text('Sara Khan'));
    const atDate = await sessionOf(session.id);
    expect(atDate).toMatchObject({ currentStepId: 'date', status: 'RUNNING' });

    const timers = ctx.app.get(FlowTimerProcessor);
    await timers.run(nameTimer);
    expect(await sessionOf(session.id)).toMatchObject({ status: 'RUNNING', currentStepId: 'date', waitToken: atDate.waitToken });

    await timers.run({ sessionId: session.id, token: atDate.waitToken });
    expect((await flowItems(chat.id)).at(-1)!.text).toBe('No problem, write visit any time.');
    expect(await sessionOf(session.id)).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });
    const steps = await ctx.prisma.flowSessionStep.findMany({ where: { sessionId: session.id }, orderBy: { id: 'asc' } });
    expect(steps.map((s) => [s.stepId, s.branch])).toEqual([
      ['name', 'next'],
      ['date', 'onTimeout'],
      ['later', 'next'],
    ]);
  });

  it('ends a session idle for 24 hours as EXPIRED, not one idle for 23', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text(keyword));
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    const sweep = ctx.app.get(FlowExpiryProcessor);

    await ctx.prisma.flowSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date(Date.now() - 23 * HOUR) } });
    await sweep.run();
    expect(await sessionOf(session.id)).toMatchObject({ status: 'RUNNING' });

    await ctx.prisma.flowSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date(Date.now() - 25 * HOUR) } });
    await sweep.run();
    expect(await sessionOf(session.id)).toMatchObject({ status: 'ENDED', result: 'EXPIRED' });
    const ended = await ctx.prisma.conversationEvent.findFirst({ where: { conversationId: chat.id, type: 'FLOW_ENDED' } });
    expect(ended?.data).toMatchObject({ result: 'EXPIRED' });
  });
});
