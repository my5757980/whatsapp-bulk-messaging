import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedNumber, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
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
});
