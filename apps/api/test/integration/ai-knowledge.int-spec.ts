import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { KnowledgeSearch } from '../../src/modules/ai/knowledge/knowledge-search.js';
import { KnowledgeProcessor } from '../../src/modules/ai/knowledge/knowledge.processor.js';
import { restoreNetwork, setDefaultCountry, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T028: US1 - written answers, websites and files become searchable knowledge (FR-011–FR-015).
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/ai/${name}`, import.meta.url)));
const SITE = 'https://shop.example.com';

describe('AI agents: knowledge (US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agentId: string;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const upload = (name: string, contentType: string) =>
    manager.agent.post(`/api/ai-agents/${agentId}/knowledge/files`).set('X-CSRF-Token', manager.csrf).attach('file', fixture(name), { filename: name, contentType });
  const processor = () => ctx.app.get(KnowledgeProcessor);
  const search = () => ctx.app.get(KnowledgeSearch);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    agentId = (await api('post', '/ai-agents', { name: `Knowledge ${suffix}` })).body.id;
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('adds, edits and deletes written answers, ready at once and searchable', async () => {
    const added = await api('post', `/ai-agents/${agentId}/knowledge/answers`, { question: 'How much is delivery to Sharjah?', answer: 'Delivery to Sharjah costs AED 50.' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ kind: 'ANSWER', status: 'READY', enabled: true, question: 'How much is delivery to Sharjah?' });
    const found = await search().retrieve(agentId, 'shipping cost to sharjah');
    expect(found.map((f) => f.id)).toContain(`src:${added.body.id}`);

    const edited = await api('patch', `/ai-agents/${agentId}/knowledge/${added.body.id}`, { answer: 'Delivery to Sharjah costs AED 40.' });
    expect(edited.body.answer).toBe('Delivery to Sharjah costs AED 40.');
    expect((await search().retrieve(agentId, 'sharjah'))[0]?.text).toContain('AED 40');

    const temp = (await api('post', `/ai-agents/${agentId}/knowledge/answers`, { question: 'Temporary?', answer: 'Yes.' })).body;
    expect((await api('delete', `/ai-agents/${agentId}/knowledge/${temp.id}`)).status).toBe(204);
    expect(await ctx.prisma.aiKnowledgeChunk.count({ where: { sourceId: temp.id } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.knowledge_added', targetId: agentId } })).toBeGreaterThanOrEqual(2);
  });

  it('reads a website in the background, then refreshes it', async () => {
    nock(SITE)
      .get('/robots.txt')
      .times(2)
      .reply(404)
      .get('/sitemap.xml')
      .times(2)
      .reply(404)
      .get('/help/')
      .reply(200, '<html><head><title>Help</title></head><body><main><h1>Help</h1><p>Assembly is free for every sofa.</p><a href="/help/returns">Returns</a></main></body></html>', { 'content-type': 'text/html' })
      .get('/help/returns')
      .reply(200, '<html><head><title>Returns</title></head><body><main><h1>Returns</h1><p>Returns are accepted within 14 days.</p></main></body></html>', { 'content-type': 'text/html' });
    const added = await api('post', `/ai-agents/${agentId}/knowledge/websites`, { url: `${SITE}/help/`, refreshWeekly: true });
    expect(added.status, JSON.stringify(added.body)).toBe(202);
    expect(added.body).toMatchObject({ kind: 'WEBSITE', status: 'PROCESSING', refreshWeekly: true });

    expect(await processor().process(added.body.id)).toBe('READY');
    const source = await ctx.prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: added.body.id } });
    expect(source).toMatchObject({ status: 'READY', pagesRead: 2, errorCode: null });
    expect((await search().retrieve(agentId, 'returns days'))[0]?.text).toContain('14 days');

    nock(SITE)
      .get('/help/')
      .reply(200, '<html><head><title>Help</title></head><body><main><p>Assembly costs AED 100.</p></main></body></html>', { 'content-type': 'text/html' });
    expect((await api('post', `/ai-agents/${agentId}/knowledge/${added.body.id}/refresh`)).status).toBe(202);
    expect((await api('post', `/ai-agents/${agentId}/knowledge/${added.body.id}/refresh`)).status).toBe(409);
    expect(await processor().process(added.body.id)).toBe('READY');
    expect((await search().retrieve(agentId, 'assembly'))[0]?.text).toContain('AED 100');
    expect((await search().retrieve(agentId, 'returns days')).some((r) => r.text.includes('14 days'))).toBe(false);
  });

  it('refuses http and private addresses for websites', async () => {
    expect((await api('post', `/ai-agents/${agentId}/knowledge/websites`, { url: 'http://shop.example.com/' })).body.code).toBe('NOT_HTTPS');
    expect((await api('post', `/ai-agents/${agentId}/knowledge/websites`, { url: 'https://192.168.1.10/' })).body.code).toBe('BLOCKED_ADDRESS');
  });

  it('reads PDF and Word files, refuses scans, duplicates and other types', async () => {
    const pdf = await upload('text.pdf', 'application/pdf');
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(202);
    expect(await processor().process(pdf.body.id)).toBe('READY');
    expect((await search().retrieve(agentId, 'sofas price'))[0]?.text).toContain('AED 2,000');

    const docx = await upload('returns.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(await processor().process(docx.body.id)).toBe('READY');
    const chunk = await ctx.prisma.aiKnowledgeChunk.findFirstOrThrow({ where: { sourceId: docx.body.id } });
    expect(chunk).toMatchObject({ title: 'returns.docx', heading: 'Returns' });

    const scanned = await upload('scanned.pdf', 'application/pdf');
    expect(await processor().process(scanned.body.id)).toBe('FAILED');
    expect(await ctx.prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: scanned.body.id } })).toMatchObject({ status: 'FAILED', errorCode: 'NO_TEXT' });

    const again = await upload('text.pdf', 'application/pdf');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_FILE');
    const html = await manager.agent
      .post(`/api/ai-agents/${agentId}/knowledge/files`)
      .set('X-CSRF-Token', manager.csrf)
      .attach('file', Buffer.from('<p>hi</p>'), { filename: 'page.html', contentType: 'text/html' });
    expect(html.status).toBe(415);

    const stored = await ctx.prisma.aiKnowledgeSource.findUniqueOrThrow({ where: { id: pdf.body.id } });
    expect((await api('delete', `/ai-agents/${agentId}/knowledge/${pdf.body.id}`)).status).toBe(204);
    await expect(ctx.app.get(StorageService).getBuffer(stored.storageKey!)).rejects.toThrow();
  });

  it('switches sources off and reports totals and the knowledge mode', async () => {
    const answer = (await api('post', `/ai-agents/${agentId}/knowledge/answers`, { question: 'Gift wrapping?', answer: 'Gift wrapping is free.' })).body;
    expect((await search().retrieve(agentId, 'gift wrapping')).map((r) => r.id)).toContain(`src:${answer.id}`);
    await api('patch', `/ai-agents/${agentId}/knowledge/${answer.id}`, { enabled: false });
    expect((await search().retrieve(agentId, 'gift wrapping')).map((r) => r.id)).not.toContain(`src:${answer.id}`);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.knowledge_switched', targetId: agentId } })).toBe(1);

    const list = await api('get', `/ai-agents/${agentId}/knowledge`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ mode: 'WHOLE', limits: { answers: 500, websites: 5, files: 50 } });
    expect(list.body.totalChars).toBeGreaterThan(0);
    expect(list.body.sources.find((s: { id: string }) => s.id === answer.id)).toMatchObject({ enabled: false });
  });
});
