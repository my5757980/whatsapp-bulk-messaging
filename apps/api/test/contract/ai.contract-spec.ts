import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 004 contract tests (T030 and later stories): responses match contracts/ai-api.openapi.yaml.
describe('AI agent API contract', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let numberId: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('ai-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    numberId = (await seedNumber(ctx)).id;
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('US1: agents, drafts, publishing, numbers, knowledge and unanswered questions', async () => {
    const created = await call('post', '/ai-agents', { name: `Contract ${randomUUID().slice(0, 6)}` });
    await check('post', '/ai-agents', created, 201);
    await check('post', '/ai-agents', await call('post', '/ai-agents', { name: '' }), 422);
    const id = created.body.id as string;
    await check('get', '/ai-agents', await call('get', '/ai-agents'), 200);
    await check('get', '/ai-agents/{id}', await call('get', `/ai-agents/${id}`), 200);
    await check('get', '/ai-agents/{id}', await call('get', `/ai-agents/${randomUUID()}`), 404);
    await check('patch', '/ai-agents/{id}', await call('patch', `/ai-agents/${id}`, { name: `Contract renamed ${randomUUID().slice(0, 6)}` }), 200);

    const config = { ...created.body.config, goal: 'Answer questions.' };
    await check('post', '/ai-agents/{id}/publish', await call('post', `/ai-agents/${id}/publish`), 422);
    await check('put', '/ai-agents/{id}/draft', await call('put', `/ai-agents/${id}/draft`, { config, draftRevision: 0 }), 200);
    await check('put', '/ai-agents/{id}/draft', await call('put', `/ai-agents/${id}/draft`, { config, draftRevision: 0 }), 409);
    await check('post', '/ai-agents/{id}/publish', await call('post', `/ai-agents/${id}/publish`), 200);
    await check('put', '/ai-agents/{id}/numbers', await call('put', `/ai-agents/${id}/numbers`, { numberIds: [numberId] }), 200);
    await check('delete', '/ai-agents/{id}', await call('delete', `/ai-agents/${id}`), 409);

    const answer = await call('post', `/ai-agents/${id}/knowledge/answers`, { question: 'Open on Friday?', answer: 'Yes, from 2 pm.' });
    await check('post', '/ai-agents/{id}/knowledge/answers', answer, 201);
    await check('post', '/ai-agents/{id}/knowledge/websites', await call('post', `/ai-agents/${id}/knowledge/websites`, { url: 'http://shop.example.com/' }), 422);
    const file = await manager.agent
      .post(`/api/ai-agents/${id}/knowledge/files`)
      .set('X-CSRF-Token', manager.csrf)
      .attach('file', readFileSync(fileURLToPath(new URL('../fixtures/ai/text.pdf', import.meta.url))), { filename: 'prices.pdf', contentType: 'application/pdf' });
    await check('post', '/ai-agents/{id}/knowledge/files', file, 202);
    await check('get', '/ai-agents/{id}/knowledge', await call('get', `/ai-agents/${id}/knowledge`), 200);
    await check('patch', '/ai-agents/{id}/knowledge/{sourceId}', await call('patch', `/ai-agents/${id}/knowledge/${answer.body.id}`, { enabled: false }), 200);
    await check('post', '/ai-agents/{id}/knowledge/{sourceId}/refresh', await call('post', `/ai-agents/${id}/knowledge/${answer.body.id}/refresh`), 409);
    await check('delete', '/ai-agents/{id}/knowledge/{sourceId}', await call('delete', `/ai-agents/${id}/knowledge/${file.body.id}`), 204);

    const question = await ctx.prisma.aiUnansweredQuestion.create({ data: { agentId: id, text: 'Price of the XL sofa', normalized: 'price of the xl sofa', askCount: 2 } });
    await check('get', '/ai-agents/{id}/unanswered', await call('get', `/ai-agents/${id}/unanswered`), 200);
    await check('post', '/ai-agents/{id}/unanswered/{questionId}/answer', await call('post', `/ai-agents/${id}/unanswered/${question.id}/answer`, { answer: 'The XL sofa costs AED 4,500.' }), 201);
    const other = await ctx.prisma.aiUnansweredQuestion.create({ data: { agentId: id, text: 'Do you sell rugs', normalized: 'do you sell rugs', askCount: 1 } });
    await check('post', '/ai-agents/{id}/unanswered/{questionId}/dismiss', await call('post', `/ai-agents/${id}/unanswered/${other.id}/dismiss`), 204);

    const copy = await call('post', `/ai-agents/${id}/duplicate`, { name: `Contract copy ${randomUUID().slice(0, 6)}` });
    await check('post', '/ai-agents/{id}/duplicate', copy, 201);
    await check('post', '/ai-agents/{id}/unpublish', await call('post', `/ai-agents/${id}/unpublish`), 200);
    await check('delete', '/ai-agents/{id}', await call('delete', `/ai-agents/${copy.body.id}`), 204);
  });

  it("US2: a chat's AI state for the live chat banner", async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });

    const none = await call('get', `/inbox/conversations/${chat.id}/ai`);
    await check('get', '/inbox/conversations/{id}/ai', none, 200);
    expect(none.body).toBeNull();

    const agent = (await call('post', '/ai-agents', { name: `Contract state ${randomUUID().slice(0, 6)}` })).body;
    await ctx.prisma.aiConversation.create({ data: { conversationId: chat.id, agentId: agent.id, numberId: number.id, contactId: chat.contactId, startedBy: 'CUSTOMER', test: false } });
    const active = await call('get', `/inbox/conversations/${chat.id}/ai`);
    await check('get', '/inbox/conversations/{id}/ai', active, 200);
    expect(active.body).toMatchObject({ agentId: agent.id, agentName: agent.name, startedBy: 'CUSTOMER', replies: 0 });
    await check('get', '/inbox/conversations/{id}/ai', await call('get', `/inbox/conversations/${randomUUID()}/ai`), 404);
  });

  it('US3: preview, versions, restore and test numbers', async () => {
    const created = (await call('post', '/ai-agents', { name: `Contract US3 ${randomUUID().slice(0, 6)}` })).body;
    expect((await call('put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, goal: 'Answer questions.' }, draftRevision: 0 })).status).toBe(200);
    expect((await call('post', `/ai-agents/${created.id}/publish`)).status).toBe(200);

    const versions = await call('get', `/ai-agents/${created.id}/versions`);
    await check('get', '/ai-agents/{id}/versions', versions, 200);
    await check('post', '/ai-agents/{id}/versions/{versionId}/restore', await call('post', `/ai-agents/${created.id}/versions/${versions.body[0].id}/restore`), 200);
    await check('post', '/ai-agents/{id}/versions/{versionId}/restore', await call('post', `/ai-agents/${created.id}/versions/${randomUUID()}/restore`), 404);
    await check('put', '/ai-agents/{id}/test-numbers', await call('put', `/ai-agents/${created.id}/test-numbers`, { testNumbers: ['+971501234567'] }), 200);
    await check('put', '/ai-agents/{id}/test-numbers', await call('put', `/ai-agents/${created.id}/test-numbers`, { testNumbers: ['12'] }), 422);

    const reply = { message: 'Hello! How can I help?', language: 'en', buttons: null, list: null, mediaId: null, usedSources: [], unanswered: null, handOver: null, remember: null, startFlow: null, optOut: null };
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .query(true)
      .reply(200, {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    try {
      await check('post', '/ai-agents/{id}/preview', await call('post', `/ai-agents/${created.id}/preview`, { messages: [{ from: 'customer', text: 'Hi' }] }), 200);
    } finally {
      nock.cleanAll();
    }
    await check('post', '/ai-agents/{id}/preview', await call('post', `/ai-agents/${randomUUID()}/preview`, { messages: [{ from: 'customer', text: 'Hi' }] }), 404);
  });

  it('US5: agent secrets and the skill test request', async () => {
    const created = (await call('post', '/ai-agents', { name: `Contract US5 ${randomUUID().slice(0, 6)}` })).body;
    const secret = await call('post', `/ai-agents/${created.id}/secrets`, { name: 'Shop token', value: 'tok_contract' });
    await check('post', '/ai-agents/{id}/secrets', secret, 201);
    await check('post', '/ai-agents/{id}/secrets', await call('post', `/ai-agents/${created.id}/secrets`, { name: '', value: 'x' }), 422);
    await check('put', '/ai-agents/{id}/secrets/{secretId}', await call('put', `/ai-agents/${created.id}/secrets/${secret.body.id}`, { value: 'tok_contract_2' }), 200);
    await check('put', '/ai-agents/{id}/secrets/{secretId}', await call('put', `/ai-agents/${created.id}/secrets/${randomUUID()}`, { name: 'Other' }), 404);

    // A loopback address is refused by the client before any connection, so no network is needed.
    const skill = { id: 'probe', name: 'Probe', whenToUse: 'Never', inputs: [], changesData: false, request: { method: 'GET', url: 'https://127.0.0.1/probe', headers: [], query: [], body: null, timeoutSeconds: 2 }, map: [] };
    await check('post', '/ai-agents/{id}/skill-test', await call('post', `/ai-agents/${created.id}/skill-test`, { skill }), 200);

    const used = (await call('post', `/ai-agents/${created.id}/secrets`, { name: 'Used', value: 'v' })).body;
    const withSecret = { ...skill, request: { ...skill.request, headers: [{ name: 'X-Key', value: `{secret:${used.id}}` }] } };
    expect((await call('put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, skills: { ...created.config.skills, api: [withSecret] } }, draftRevision: 0 })).status).toBe(200);
    await check('delete', '/ai-agents/{id}/secrets/{secretId}', await call('delete', `/ai-agents/${created.id}/secrets/${used.id}`), 409);
    await check('delete', '/ai-agents/{id}/secrets/{secretId}', await call('delete', `/ai-agents/${created.id}/secrets/${secret.body.id}`), 204);
  });

  it('US7: usage and AI settings (admins)', async () => {
    const admin = await signIn(ctx, 'ADMIN');
    const asAdmin = (method: 'get' | 'put', url: string, body?: object) => {
      const req = admin.agent[method](`/api${url}`);
      return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
    };
    await check('get', '/ai-usage', await asAdmin('get', '/ai-usage'), 200);
    await check('get', '/ai-usage', await asAdmin('get', '/ai-usage?month=2026-01'), 200);
    await check('get', '/ai-usage', await asAdmin('get', '/ai-usage?month=2026-1'), 422);
    const settings = await asAdmin('get', '/ai-settings');
    await check('get', '/ai-settings', settings, 200);
    await check('put', '/ai-settings', await asAdmin('put', '/ai-settings', { ...settings.body, limitMessage: 'Our team will reply soon.' }), 200);
    await check('put', '/ai-settings', await asAdmin('put', '/ai-settings', { ...settings.body, replyLimit: -1 }), 422);
    expect((await asAdmin('put', '/ai-settings', settings.body)).status).toBe(200);
  });
});
