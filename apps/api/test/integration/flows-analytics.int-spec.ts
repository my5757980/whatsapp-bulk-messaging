import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T073: US8 analytics over seeded sessions - totals per result, entered / continued / dropped per
// step and counts per option for today, 7 days, 30 days and a custom range in the company time zone;
// test sessions left out; the CSV of contacts who dropped at a step (FR-035, FR-036, SC-005).
describe('Chatbot flows: analytics (US8)', () => {
  let ctx: TestContext;
  let number: { id: string };
  let manager: SignedInAgent;
  let flowId: string;
  let versionId: string;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const DAY = 86_400_000;
  const timedOutNames: string[] = [];

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };

  /** One finished session that walked these steps (step id and the branch it left by, or null). */
  async function seedSession(path: Array<[string, string | null]>, result: 'COMPLETED' | 'TIMED_OUT', options: { startedAt?: Date; isTest?: boolean; name?: string } = {}) {
    const contact = await seedContact(ctx, uaePhone(), { name: options.name ?? null });
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    const startedAt = options.startedAt ?? new Date(Date.now() - 60_000);
    const session = await ctx.prisma.flowSession.create({
      data: {
        flowId,
        flowVersionId: options.isTest ? null : versionId,
        conversationId: chat.id,
        contactId: contact.id,
        numberId: number.id,
        isTest: options.isTest ?? false,
        startedBy: 'TRIGGER',
        status: 'ENDED',
        result,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30_000),
      },
    });
    for (const [stepId, branch] of path) {
      await ctx.prisma.flowSessionStep.create({ data: { sessionId: session.id, flowId, flowVersionId: versionId, stepId, enteredAt: startedAt, leftAt: branch ? startedAt : null, branch } });
    }
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    flowId = (await api('post', '/flows', { name: `Analytics ${suffix}` })).body.id;
    const graph = {
      version: 1,
      start: 'menu',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`stats${suffix}`], canInterrupt: false }],
      steps: [
        { id: 'menu', type: 'buttons', text: 'Pick one', buttons: [{ key: 'a', title: 'A', next: 'ask' }, { key: 'b', title: 'B', next: 'ask' }] },
        { id: 'ask', type: 'question', text: 'Your email?', answer: { kind: 'email' }, answerName: 'email', retryText: 'Please send an email.', next: 'done' },
        { id: 'done', type: 'end' },
      ],
    };
    await api('put', `/flows/${flowId}/draft`, { graph, draftRevision: 0 });
    const published = await api('post', `/flows/${flowId}/publish`);
    versionId = published.body.publishedVersion.id;

    // Today: 6 complete the flow, 4 time out at the email question.
    for (let i = 0; i < 6; i++) await seedSession([['menu', i < 3 ? 'a' : 'b'], ['ask', 'next'], ['done', 'end']], 'COMPLETED');
    for (let i = 0; i < 4; i++) {
      const name = `Dropped ${suffix} ${i}`;
      timedOutNames.push(name);
      await seedSession([['menu', 'a'], ['ask', 'onTimeout']], 'TIMED_OUT', { name });
    }
    // A test run today (left out) and two sessions ten days ago (only in 30 days and the custom range).
    await seedSession([['menu', 'a'], ['ask', 'next'], ['done', 'end']], 'COMPLETED', { isTest: true });
    for (let i = 0; i < 2; i++) await seedSession([['menu', 'b'], ['ask', 'next'], ['done', 'end']], 'COMPLETED', { startedAt: new Date(Date.now() - 10 * DAY) });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('counts results and steps for the last 7 days, leaving out test runs', async () => {
    const res = await api('get', `/flows/${flowId}/analytics?period=7d`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals).toMatchObject({ started: 10, completed: 6, timedOut: 4, running: 0, other: 0 });
    const step = (id: string) => (res.body.steps as Array<{ stepId: string }>).find((s) => s.stepId === id);
    expect(step('menu')).toMatchObject({ entered: 10, continued: 10, dropped: 0 });
    expect(step('ask')).toMatchObject({ entered: 10, continued: 6, dropped: 4 });
    expect(step('done')).toMatchObject({ entered: 6, continued: 6, dropped: 0 });
    expect((step('menu') as unknown as { options: Array<{ key: string; count: number }> }).options).toEqual(expect.arrayContaining([{ key: 'a', count: 7 }, { key: 'b', count: 3 }]));
  });

  it('uses today, 30 days and custom ranges in the company time zone', async () => {
    expect((await api('get', `/flows/${flowId}/analytics?period=today`)).body.totals.started).toBe(10);
    expect((await api('get', `/flows/${flowId}/analytics?period=30d`)).body.totals.started).toBe(12);
    const tenDaysAgo = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - 11 * DAY).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.now() - 9 * DAY).toISOString().slice(0, 10);
    const custom = await api('get', `/flows/${flowId}/analytics?period=custom&from=${dayBefore}&to=${dayAfter}`);
    expect(custom.status).toBe(200);
    expect(custom.body.totals).toMatchObject({ started: 2, completed: 2 });
    expect(custom.body.from <= `${tenDaysAgo}T23:59:59Z`).toBe(true);
    expect((await api('get', `/flows/${flowId}/analytics?period=custom&from=${dayAfter}&to=${dayBefore}`)).status).toBe(422);
    expect((await api('get', `/flows/${flowId}/analytics?period=custom`)).status).toBe(422);
  });

  it('downloads the contacts who dropped at a step as CSV', async () => {
    const res = await api('get', `/flows/${flowId}/analytics/steps/ask/dropped?period=7d`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('name,phone,result,ended_at');
    expect(lines).toHaveLength(5);
    expect(lines.slice(1).map((l: string) => l.split(',')[0]).sort()).toEqual([...timedOutNames].sort());
    expect(lines.slice(1).every((l: string) => l.includes(',TIMED_OUT,'))).toBe(true);
    expect((await api('get', `/flows/${flowId}/analytics/steps/menu/dropped?period=7d`)).text.trim().split(/\r?\n/)).toHaveLength(1);
  });
});
