import { randomUUID } from 'node:crypto';
import { defaultAgentConfig } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedNumber, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T027: US1 - create, save, publish, rename, duplicate, delete agents and choose their numbers
// (FR-001–FR-005, FR-050).
describe('AI agents: build and publish (US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const audited = (action: string, targetId: string) => ctx.prisma.auditLog.count({ where: { action, targetId } });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates agents with our defaults, saves drafts with a revision check and lists what blocks publishing', async () => {
    const created = await api('post', '/ai-agents', { name: `Sales assistant ${suffix}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', draftRevision: 0, publishedVersion: null, numbers: [], testNumbers: [], secrets: [] });
    expect(created.body.config).toMatchObject({ version: 1, displayName: `Sales assistant ${suffix}`, replyLanguages: ['en', 'ar'], whenUnsure: 'say_so', replyCap: 20 });
    expect(created.body.problems.map((p: { code: string }) => p.code)).toContain('NO_GOAL');
    expect(await audited('ai.agent_created', created.body.id)).toBe(1);
    expect((await api('post', '/ai-agents', { name: `Sales assistant ${suffix}` })).status).toBe(409);
    expect((await api('post', '/ai-agents', { name: '' })).status).toBe(422);

    const config = { ...created.body.config, goal: 'Answer questions about our furniture and delivery.' };
    const saved = await api('put', `/ai-agents/${created.body.id}/draft`, { config, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({ draftRevision: 1, problems: [] });
    const stale = await api('put', `/ai-agents/${created.body.id}/draft`, { config, draftRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('DRAFT_CONFLICT');
    expect((await api('put', `/ai-agents/${created.body.id}/draft`, { config: { ...config, replyCap: 500 }, draftRevision: 1 })).status).toBe(422);
  });

  it('refuses to publish with problems, then publishes numbered versions', async () => {
    const created = (await api('post', '/ai-agents', { name: `Support ${suffix}` })).body;
    const blocked = await api('post', `/ai-agents/${created.id}/publish`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');
    expect(blocked.body.problems.map((p: { code: string }) => p.code)).toContain('NO_GOAL');

    const config = {
      ...defaultAgentConfig('Sara'),
      goal: 'Help customers with orders.',
      skills: { ...defaultAgentConfig().skills, memory: [{ key: `missing_${suffix}`, description: 'Not there' }] },
    };
    await api('put', `/ai-agents/${created.id}/draft`, { config, draftRevision: 0 });
    const unknown = await api('post', `/ai-agents/${created.id}/publish`);
    expect(unknown.body.problems.map((p: { code: string }) => p.code)).toEqual(['UNKNOWN_ATTRIBUTE']);

    await api('put', `/ai-agents/${created.id}/draft`, { config: { ...config, skills: defaultAgentConfig().skills }, draftRevision: 1 });
    const published = await api('post', `/ai-agents/${created.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ status: 'PUBLISHED', publishedVersion: { number: 1 }, hasUnpublishedChanges: false });
    expect(await audited('ai.agent_published', created.id)).toBe(1);

    await api('put', `/ai-agents/${created.id}/draft`, { config: { ...config, skills: defaultAgentConfig().skills, goal: 'Help customers with orders and returns.' }, draftRevision: 2 });
    expect((await api('get', `/ai-agents/${created.id}`)).body.hasUnpublishedChanges).toBe(true);
    expect((await api('post', `/ai-agents/${created.id}/publish`)).body.publishedVersion.number).toBe(2);
    const versions = await ctx.prisma.aiAgentVersion.findMany({ where: { agentId: created.id }, orderBy: { number: 'asc' } });
    expect(versions.map((v) => v.number)).toEqual([1, 2]);
    expect((versions[0]!.config as { goal: string }).goal).toBe('Help customers with orders.');

    expect((await api('delete', `/ai-agents/${created.id}`)).status).toBe(409);
    const unpublished = await api('post', `/ai-agents/${created.id}/unpublish`);
    expect(unpublished.body.status).toBe('UNPUBLISHED');
    expect((await api('delete', `/ai-agents/${created.id}`)).status).toBe(204);
    expect((await api('get', `/ai-agents/${created.id}`)).status).toBe(404);
    expect(await audited('ai.agent_deleted', created.id)).toBe(1);
  });

  it('renames and duplicates an agent with its knowledge and secrets', async () => {
    const created = (await api('post', '/ai-agents', { name: `Booking ${suffix}` })).body;
    expect((await api('patch', `/ai-agents/${created.id}`, { name: `Bookings ${suffix}` })).body.name).toBe(`Bookings ${suffix}`);
    await api('post', `/ai-agents/${created.id}/knowledge/answers`, { question: 'Do you open on Friday?', answer: 'Yes, from 2 pm.' });
    const secret = await ctx.prisma.aiAgentSecret.create({ data: { agentId: created.id, name: 'Shop token', valueEncrypted: 'v1:abc:def:ghi' } });
    const skill = {
      id: 'order_status',
      name: 'Order status',
      whenToUse: 'When asked about an order.',
      inputs: [],
      changesData: false,
      request: { method: 'GET', url: 'https://shop.example.com/orders', headers: [{ name: 'Authorization', value: `Bearer {secret:${secret.id}}` }], query: [], body: null, timeoutSeconds: 5 },
      map: [{ from: 'status', to: 'status' }],
    };
    await api('put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, skills: { ...created.config.skills, api: [skill] } }, draftRevision: 0 });

    const copy = await api('post', `/ai-agents/${created.id}/duplicate`, { name: `Bookings copy ${suffix}` });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body).toMatchObject({ status: 'DRAFT', name: `Bookings copy ${suffix}`, secrets: [{ name: 'Shop token' }] });
    const copiedSecretId = copy.body.secrets[0].id as string;
    expect(copiedSecretId).not.toBe(secret.id);
    expect(copy.body.config.skills.api[0].request.headers[0].value).toBe(`Bearer {secret:${copiedSecretId}}`);
    const answers = await ctx.prisma.aiKnowledgeSource.findMany({ where: { agentId: copy.body.id }, include: { chunks: true } });
    expect(answers).toMatchObject([{ kind: 'ANSWER', question: 'Do you open on Friday?', chunks: [{ text: 'Q: Do you open on Friday?\nA: Yes, from 2 pm.' }] }]);
    expect(await audited('ai.agent_duplicated', copy.body.id)).toBe(1);
  });

  it('gives each number at most one agent, taking a number from another agent only when asked', async () => {
    const number = await seedNumber(ctx);
    const first = (await api('post', '/ai-agents', { name: `First ${suffix}` })).body;
    const second = (await api('post', '/ai-agents', { name: `Second ${suffix}` })).body;
    const assigned = await api('put', `/ai-agents/${first.id}/numbers`, { numberIds: [number.id] });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.numbers).toEqual([{ id: number.id, displayPhone: number.displayPhoneNumber }]);

    const taken = await api('put', `/ai-agents/${second.id}/numbers`, { numberIds: [number.id] });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NUMBER_HAS_AGENT');
    const replaced = await api('put', `/ai-agents/${second.id}/numbers`, { numberIds: [number.id], replace: true });
    expect(replaced.body.numbers).toHaveLength(1);
    expect((await api('get', `/ai-agents/${first.id}`)).body.numbers).toEqual([]);
    expect(await audited('ai.number_agent_changed', second.id)).toBe(1);
    expect((await api('put', `/ai-agents/${second.id}/numbers`, { numberIds: [randomUUID()] })).status).toBe(422);
  });

  it('is for admins and managers only', async () => {
    const agentRole = await signIn(ctx, 'AGENT');
    expect((await agentRole.agent.get('/api/ai-agents')).status).toBe(403);
  });
});
