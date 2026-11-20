import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedNumber, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 003 contract tests (T019 and later stories): responses match contracts/flows-api.openapi.yaml.
describe('Chatbot flows API contract', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('flows-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const graph = () => ({
    version: 1,
    start: 'a',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`contract${randomUUID().slice(0, 6)}`], canInterrupt: false }],
    steps: [
      { id: 'a', type: 'buttons', text: 'Pick one', buttons: [{ key: 'yes', title: 'Yes', next: 'b' }] },
      { id: 'b', type: 'end' },
    ],
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('US1: flows, drafts, publishing and unpublishing', async () => {
    const created = await call('post', '/flows', { name: `Contract ${randomUUID().slice(0, 6)}` });
    await check('post', '/flows', created, 201);
    await check('post', '/flows', await call('post', '/flows', { name: '' }), 422);
    const id = created.body.id as string;
    await check('get', '/flows', await call('get', '/flows'), 200);
    await check('get', '/flows/{id}', await call('get', `/flows/${id}`), 200);
    await check('get', '/flows/{id}', await call('get', `/flows/${randomUUID()}`), 404);
    await check('patch', '/flows/{id}', await call('patch', `/flows/${id}`, { priority: 50 }), 200);
    await check('put', '/flows/{id}/draft', await call('put', `/flows/${id}/draft`, { graph: { version: 1, start: null, triggers: [], steps: [] }, draftRevision: 0 }), 200);
    await check('put', '/flows/{id}/draft', await call('put', `/flows/${id}/draft`, { graph: { version: 1, start: null, triggers: [], steps: [] }, draftRevision: 0 }), 409);
    await check('post', '/flows/{id}/publish', await call('post', `/flows/${id}/publish`), 422);
    await check('put', '/flows/{id}/draft', await call('put', `/flows/${id}/draft`, { graph: graph(), draftRevision: 1 }), 200);
    await check('post', '/flows/{id}/publish', await call('post', `/flows/${id}/publish`), 200);
    await check('delete', '/flows/{id}', await call('delete', `/flows/${id}`), 409);
    await check('post', '/flows/{id}/duplicate', await call('post', `/flows/${id}/duplicate`), 201);
    await check('post', '/flows/{id}/unpublish', await call('post', `/flows/${id}/unpublish`), 200);
    await check('delete', '/flows/{id}', await call('delete', `/flows/${id}`), 204);
  });
});
