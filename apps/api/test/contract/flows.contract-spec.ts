import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 003 contract tests (T019 and later stories): responses match contracts/flows-api.openapi.yaml.
describe('Chatbot flows API contract', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let numberId: string;

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
    numberId = (await seedNumber(ctx)).id;
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

  it('US3: starting a flow from a chat and the running session', async () => {
    const created = await call('post', '/flows', { name: `Contract chat ${randomUUID().slice(0, 6)}` });
    const id = created.body.id as string;
    await call('put', `/flows/${id}/draft`, { graph: graph(), draftRevision: 0 });
    expect((await call('post', `/flows/${id}/publish`)).status).toBe(200);
    const contact = await seedContact(ctx, uaePhone());
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId, state: 'ACTIVE', lastCustomerMessageAt: new Date() } });
    const base = `/inbox/conversations/${chat.id}`;

    await check('get', '/inbox/conversations/{id}/flow-session', await call('get', `${base}/flow-session`), 200);
    await check('get', '/inbox/conversations/{id}/flows', await call('get', `${base}/flows`), 200);
    await check('get', '/inbox/conversations/{id}/flows', await call('get', `/inbox/conversations/${randomUUID()}/flows`), 404);
    await check('post', '/inbox/conversations/{id}/flows', await call('post', `${base}/flows`, { flowId: randomUUID() }), 404);
    await check('post', '/inbox/conversations/{id}/flows', await call('post', `${base}/flows`, { flowId: id }), 201);
    await check('get', '/inbox/conversations/{id}/flow-session', await call('get', `${base}/flow-session`), 200);
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { lastCustomerMessageAt: new Date(Date.now() - 25 * 3_600_000) } });
    await check('post', '/inbox/conversations/{id}/flows', await call('post', `${base}/flows`, { flowId: id }), 409);
  });

  it('US5: secrets and the test request', async () => {
    const created = await call('post', '/flows', { name: `Contract secrets ${randomUUID().slice(0, 6)}` });
    const id = created.body.id as string;
    const secret = await call('post', `/flows/${id}/secrets`, { name: 'Token', value: 'abc-123' });
    await check('post', '/flows/{id}/secrets', secret, 201);
    await check('post', '/flows/{id}/secrets', await call('post', `/flows/${id}/secrets`, { name: '' }), 422);
    await check('put', '/flows/{id}/secrets/{secretId}', await call('put', `/flows/${id}/secrets/${secret.body.id}`, { name: 'Shop token' }), 200);
    await check('put', '/flows/{id}/secrets/{secretId}', await call('put', `/flows/${id}/secrets/${randomUUID()}`, { name: 'x' }), 404);

    // The test request refuses private addresses without calling them.
    const step = { id: 'call', type: 'api', url: 'https://10.0.0.5/orders', headers: [{ name: 'Authorization', value: `Bearer {secret:${secret.body.id}}` }] };
    await check('post', '/flows/{id}/api-test', await call('post', `/flows/${id}/api-test`, { step }), 200);
    await check('post', '/flows/{id}/api-test', await call('post', `/flows/${id}/api-test`, { step: { id: 'm', type: 'message', text: 'hi' } }), 422);

    // A secret the draft uses cannot be deleted; once unused it can.
    await call('put', `/flows/${id}/draft`, { graph: { version: 1, start: 'call', triggers: [], steps: [step] }, draftRevision: 0 });
    await check('delete', '/flows/{id}/secrets/{secretId}', await call('delete', `/flows/${id}/secrets/${secret.body.id}`), 409);
    await call('put', `/flows/${id}/draft`, { graph: { version: 1, start: null, triggers: [], steps: [] }, draftRevision: 1 });
    await check('delete', '/flows/{id}/secrets/{secretId}', await call('delete', `/flows/${id}/secrets/${secret.body.id}`), 204);
  });
});
