import { randomUUID } from 'node:crypto';
import { AGENT_STARTERS, agentStarterByKey, agentStarterConfig } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T092: US8 - starter agents (FR-040, FR-041) and the "replace me" publish check (FR-005).
describe('AI agents: starter agents (US8)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agentMember: SignedInAgent;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const definedKeys = async (keys: string[]) =>
    new Set((await ctx.prisma.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true } })).map((a) => a.key));
  /** Creates the attributes a starter suggests; one that exists already is fine. */
  const createAttributes = async (starterKey: string) => {
    for (const a of agentStarterByKey(starterKey)!.attributes) {
      const res = await api('post', '/attributes', { key: a.key, label: a.label, type: a.type });
      expect([201, 409], JSON.stringify(res.body)).toContain(res.status);
    }
  };
  const codes = (body: { problems: Array<{ code: string }> }) => body.problems.map((p) => p.code);

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    agentMember = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('lists the four starters, with flags that say which suggested attributes exist', async () => {
    const res = await api('get', '/ai-agent-starters');
    expect(res.status).toBe(200);
    expect(res.body.map((s: { key: string }) => s.key)).toEqual(AGENT_STARTERS.map((s) => s.key));
    const lead = res.body.find((s: { key: string }) => s.key === 'lead_qualification');
    expect(lead).toMatchObject({ name: 'Lead qualification', description: agentStarterByKey('lead_qualification')!.description });

    const allKeys = AGENT_STARTERS.flatMap((s) => s.attributes.map((a) => a.key));
    const before = await definedKeys(allKeys);
    for (const starter of res.body as Array<{ suggestedAttributes: Array<{ key: string; label: string; type: string; exists: boolean }> }>) {
      for (const attribute of starter.suggestedAttributes) expect(attribute.exists, attribute.key).toBe(before.has(attribute.key));
    }
    expect(lead.suggestedAttributes.map((a: { key: string; label: string; type: string }) => ({ key: a.key, label: a.label, type: a.type }))).toEqual(
      agentStarterByKey('lead_qualification')!.attributes.map(({ key, label, type }) => ({ key, label, type })),
    );

    await createAttributes('lead_qualification');
    const after = (await api('get', '/ai-agent-starters')).body.find((s: { key: string }) => s.key === 'lead_qualification');
    expect(after.suggestedAttributes.every((a: { exists: boolean }) => a.exists)).toBe(true);

    expect((await agentMember.agent.get('/api/ai-agent-starters')).status).toBe(403);
  });

  it('creates a complete draft from a starter, with its example answers marked "replace me"', async () => {
    const name = `Front desk ${suffix}`;
    const created = await api('post', '/ai-agents', { name, starterKey: 'booking_requests' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const starter = agentStarterByKey('booking_requests')!;
    expect(created.body).toMatchObject({ status: 'DRAFT', starterKey: 'booking_requests', draftRevision: 0 });
    expect(created.body.config).toEqual(agentStarterConfig(starter, name));
    expect(codes(created.body)).toContain('REPLACE_ME_LEFT');

    const knowledge = await api('get', `/ai-agents/${created.body.id}/knowledge`);
    expect(knowledge.status).toBe(200);
    expect(knowledge.body.sources.map((s: { kind: string; question: string; answer: string; replaceMe: boolean; status: string }) => ({ kind: s.kind, question: s.question, answer: s.answer, replaceMe: s.replaceMe, status: s.status }))).toEqual(
      starter.exampleAnswers.map((e) => ({ kind: 'ANSWER', question: e.question, answer: e.answer, replaceMe: true, status: 'READY' })),
    );
    // The answers are searchable knowledge like any other.
    expect(await ctx.prisma.aiKnowledgeChunk.count({ where: { agentId: created.body.id } })).toBe(starter.exampleAnswers.length);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'ai.agent_created', targetId: created.body.id } });
    expect(audit.metadata).toMatchObject({ name, starter: 'booking_requests' });
    expect((await ctx.prisma.aiAgent.findUniqueOrThrow({ where: { id: created.body.id } })).starterKey).toBe('booking_requests');

    // An empty agent has no starter and no knowledge.
    const empty = await api('post', '/ai-agents', { name: `Blank ${suffix}` });
    expect(empty.body.starterKey).toBeNull();
    expect((await api('get', `/ai-agents/${empty.body.id}/knowledge`)).body.sources).toEqual([]);
  });

  it('refuses an unknown starter and keeps nothing', async () => {
    const res = await api('post', '/ai-agents', { name: `Nobody ${suffix}`, starterKey: 'no_such_starter' });
    expect(res.status).toBe(422);
    expect(await ctx.prisma.aiAgent.count({ where: { name: `Nobody ${suffix}` } })).toBe(0);
    // A taken name leaves no example answers behind either.
    const answers = await ctx.prisma.aiKnowledgeSource.count({ where: { replaceMe: true } });
    expect((await api('post', '/ai-agents', { name: `Front desk ${suffix}`, starterKey: 'sales_enquiries' })).status).toBe(409);
    expect(await ctx.prisma.aiKnowledgeSource.count({ where: { replaceMe: true } })).toBe(answers);
  });

  it('refuses publishing until every example answer is replaced or removed', async () => {
    await createAttributes('lead_qualification');
    const agent = (await api('post', '/ai-agents', { name: `Leads ${suffix}`, starterKey: 'lead_qualification' })).body;
    const blocked = await api('post', `/ai-agents/${agent.id}/publish`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PUBLISH_BLOCKED');
    expect(codes(blocked.body)).toEqual(['REPLACE_ME_LEFT']);
    expect(blocked.body.problems[0].message).toContain('3 example answer(s)');

    const sources = (await api('get', `/ai-agents/${agent.id}/knowledge`)).body.sources as Array<{ id: string }>;
    const replaced = await api('patch', `/ai-agents/${agent.id}/knowledge/${sources[0]!.id}`, { answer: 'We build online shops for small businesses.' });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.replaceMe).toBe(false);
    // Switching an example off does not replace it.
    expect((await api('patch', `/ai-agents/${agent.id}/knowledge/${sources[1]!.id}`, { enabled: false })).body.replaceMe).toBe(true);
    const still = await api('post', `/ai-agents/${agent.id}/publish`);
    expect(still.status).toBe(422);
    expect(still.body.problems[0].message).toContain('2 example answer(s)');

    for (const source of sources.slice(1)) expect((await api('delete', `/ai-agents/${agent.id}/knowledge/${source.id}`)).status).toBe(204);
    const published = await api('post', `/ai-agents/${agent.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.status).toBe('PUBLISHED');
  });
});
