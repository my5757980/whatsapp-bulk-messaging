import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T067: US7 - test numbers run the draft (marked test, no step records), others get the published
// version or nothing; at most 3 test numbers; unpublishing ends sessions at their next message;
// sessions finish on the version they started on; revisions are pruned to 20; restore (FR-004–FR-007,
// FR-034).
describe('Chatbot flows: test numbers, versions and restore (US7)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let manager: SignedInAgent;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);

  const api = (method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) => {
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
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const text = (body: string) => ({ type: 'text', text: { body } });
  const tap = (id: string, title: string) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const items = (conversationId: string) => ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const texts = async (conversationId: string) => (await items(conversationId)).map((i) => i.text);
  const graph = (word: string, greeting: string) => ({
    version: 1,
    start: 'a',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [word], canInterrupt: false }],
    steps: [{ id: 'a', type: 'message', text: greeting, next: null }],
  });
  const create = async (name: string, draft: object) => {
    const id = (await api('post', '/flows', { name: `${name} ${suffix}` })).body.id as string;
    expect((await api('put', `/flows/${id}/draft`, { graph: draft, draftRevision: 0 })).status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('runs the draft for test numbers and the published version for everyone else', async () => {
    const word = `hello${suffix}`;
    const id = await create('Greeting', graph(word, 'Published hello'));
    expect((await api('post', `/flows/${id}/publish`)).status).toBe(200);
    expect((await api('put', `/flows/${id}/draft`, { graph: graph(word, 'Draft hello'), draftRevision: 1 })).status).toBe(200);

    const tester = uaePhone();
    const set = await api('patch', `/flows/${id}`, { testNumbers: [`0${tester.slice(4)}`] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.testNumbers).toEqual([tester]);
    expect((await api('patch', `/flows/${id}`, { testNumbers: ['+971500000001', '+971500000002', '+971500000003', '+971500000004'] })).status).toBe(422);

    const testChat = await inbound(tester, text(word));
    expect(await texts(testChat.id)).toEqual(['Draft hello']);
    const testSession = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: testChat.id } });
    expect(testSession).toMatchObject({ isTest: true, flowVersionId: null });
    expect(((await items(testChat.id))[0]!.payload as { flow: { test: boolean } }).flow.test).toBe(true);
    expect(await ctx.prisma.flowSessionStep.count({ where: { sessionId: testSession.id } })).toBe(0);

    const otherChat = await inbound(uaePhone(), text(word));
    expect(await texts(otherChat.id)).toEqual(['Published hello']);
    const otherSession = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: otherChat.id } });
    expect(otherSession.isTest).toBe(false);
    expect(await ctx.prisma.flowSessionStep.count({ where: { sessionId: otherSession.id } })).toBeGreaterThan(0);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'flow.test_numbers_updated', targetId: id } });
    expect(audit).toBeTruthy();
  });

  it('lets a test number try a flow that was never published, while others get nothing', async () => {
    const word = `draftonly${suffix}`;
    const id = await create('Draft only', graph(word, 'Only testers see this'));
    const tester = uaePhone();
    expect((await api('patch', `/flows/${id}`, { testNumbers: [tester] })).status).toBe(200);
    expect(await texts((await inbound(tester, text(word))).id)).toEqual(['Only testers see this']);
    expect(await texts((await inbound(uaePhone(), text(word))).id)).toEqual([]);
  });

  it('finishes sessions on their version, and ends them at their next message after unpublishing', async () => {
    const word = `version${suffix}`;
    const buttons = (question: string, answer: string) => ({
      version: 1,
      start: 'q',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [word], canInterrupt: false }],
      steps: [
        { id: 'q', type: 'buttons', text: question, buttons: [{ key: 'yes', title: 'Yes', next: 'a' }] },
        { id: 'a', type: 'message', text: answer, next: null },
      ],
    });
    const id = await create('Versions', buttons('Version one?', 'Answer one'));
    expect((await api('post', `/flows/${id}/publish`)).status).toBe(200);

    const phone = uaePhone();
    const chat = await inbound(phone, text(word));
    const asked = (await items(chat.id))[0]!;
    expect((await api('put', `/flows/${id}/draft`, { graph: buttons('Version two?', 'Answer two'), draftRevision: 1 })).status).toBe(200);
    expect((await api('post', `/flows/${id}/publish`)).status).toBe(200);
    await inbound(phone, tap((asked.payload as { buttons: Array<{ id: string }> }).buttons[0]!.id, 'Yes'));
    expect(await texts(chat.id)).toEqual(['Version one?', 'Answer one']);

    const later = uaePhone();
    const laterChat = await inbound(later, text(word));
    expect(await texts(laterChat.id)).toEqual(['Version two?']);
    expect((await api('post', `/flows/${id}/unpublish`)).status).toBe(200);
    await inbound(later, text('Yes'));
    expect(await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: laterChat.id } })).toMatchObject({ status: 'ENDED', result: 'FLOW_UNPUBLISHED' });
    expect(await texts(laterChat.id)).toEqual(['Version two?']);
  });

  it('keeps 20 autosave revisions and restores a version into the draft', async () => {
    const word = `restore${suffix}`;
    const id = await create('Restore', graph(word, 'First text'));
    expect((await api('post', `/flows/${id}/publish`)).status).toBe(200);
    // Older revisions, one a minute apart.
    await ctx.prisma.flowVersion.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ flowId: id, kind: 'REVISION' as const, graph: graph(word, `Old ${i}`), createdAt: new Date(Date.now() - (30 + i) * 60_000) })),
    });
    expect((await api('put', `/flows/${id}/draft`, { graph: graph(word, 'Latest text'), draftRevision: 1 })).status).toBe(200);
    expect(await ctx.prisma.flowVersion.count({ where: { flowId: id, kind: 'REVISION' } })).toBe(20);

    const versions = await api('get', `/flows/${id}/versions`);
    expect(versions.status).toBe(200);
    const published = (versions.body as Array<{ id: string; kind: string; number: number | null; current: boolean }>).find((v) => v.kind === 'PUBLISHED')!;
    expect(published).toMatchObject({ number: 1, current: true });

    const restored = await api('post', `/flows/${id}/versions/${published.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.graph.steps[0].text).toBe('First text');
    expect(restored.body.draftRevision).toBe(3);
    // The draft it replaced is kept as the newest revision, so the restore can be undone.
    const newest = await ctx.prisma.flowVersion.findFirstOrThrow({ where: { flowId: id, kind: 'REVISION' }, orderBy: { createdAt: 'desc' } });
    expect((newest.graph as { steps: Array<{ text: string }> }).steps[0]!.text).toBe('Latest text');
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'flow.restored', targetId: id } })).toBeTruthy();
  });
});
