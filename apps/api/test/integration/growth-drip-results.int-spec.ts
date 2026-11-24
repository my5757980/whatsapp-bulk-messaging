import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DripTickProcessor } from '../../src/modules/growth/drips/drip-tick.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T055 (feature 005, US6, FR-035, FR-036, research R11): drip results equal the records, with the
// contacts behind each count and an export.
const HOUR = 3_600_000;

describe('Drip results (005 US6)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let dripId: string;
  let stepIds: string[];
  const people: Record<string, { id: string; phoneE164: string }> = {};

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) =>
    method === 'get' ? who.agent.get(`/api${url}`) : who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const contactsOf = async (metric: string, stepId = stepIds[0]!) =>
    ((await api(manager, 'get', `/drips/${dripId}/results/contacts?stepId=${stepId}&metric=${metric}`)).body.items as Array<{ id: string }>).map((c) => c.id).sort();

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { defaultTimezone: 'UTC' } });
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx);
    const marketing = await seedTemplate(ctx, number.wabaId, { name: `results_${uniq('').slice(0, 6)}`, category: 'MARKETING' });

    const created = await api(manager, 'post', '/drips', { name: `Results ${uniq('')}`, numberId: number.id });
    dripId = created.body.id;
    const step = (waitMinutes: number) => ({ templateId: marketing.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes });
    const saved = await api(manager, 'put', `/drips/${dripId}/steps`, { steps: [step(0), step(60)] });
    stepIds = (saved.body.stepList as Array<{ id: string }>).map((s) => s.id);
    expect((await api(manager, 'post', `/drips/${dripId}/activate`)).status).toBe(200);

    for (const [name, consentStatus] of [
      ['Reader', 'OPTED_IN'],
      ['Receiver', 'OPTED_IN'],
      ['Failure', 'OPTED_IN'],
      ['Unknown', 'UNKNOWN'],
    ] as const) {
      people[name] = await seedContact(ctx, uaePhone(), { name, consentStatus });
    }
    await api(manager, 'post', `/drips/${dripId}/enrolments`, { contactIds: Object.values(people).map((p) => p.id) });
    await ctx.app.get(DripTickProcessor).tick();

    // Step 1 results: Reader read it, clicked and replied; Receiver got it; Failure failed; Unknown was skipped (no opt-in).
    const message = (name: string) => ctx.prisma.message.findFirstOrThrow({ where: { contactId: people[name]!.id, dripStepId: stepIds[0] } });
    const now = Date.now();
    const reader = await message('Reader');
    await ctx.prisma.message.update({
      where: { id: reader.id },
      data: { status: 'READ', waMessageId: `wamid.res.${uniq('')}`, sentAt: new Date(now - 2 * HOUR), deliveredAt: new Date(now - 2 * HOUR), readAt: new Date(now - HOUR) },
    });
    const target = await ctx.prisma.trackedLinkTarget.create({ data: { dripStepId: stepIds[0]!, variableKey: 'BODY.1', destination: 'https://shop.example/r' } });
    const link = await ctx.prisma.trackedLink.create({ data: { code: `Rs${uniq('').slice(0, 8)}`, targetId: target.id, messageId: reader.id, contactId: people.Reader!.id } });
    await ctx.prisma.linkClick.create({ data: { trackedLinkId: link.id, targetId: target.id, dripStepId: stepIds[0]!, contactId: people.Reader!.id, device: 'MOBILE' } });
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, people.Reader!.phoneE164.slice(1), 'Got it, thanks')));
    await ctx.prisma.message.update({ where: { id: (await message('Receiver')).id }, data: { status: 'DELIVERED', sentAt: new Date(now - HOUR), deliveredAt: new Date(now - HOUR) } });
    await ctx.prisma.message.update({ where: { id: (await message('Failure')).id }, data: { status: 'FAILED', failureCode: 131000, failedAt: new Date() } });
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('counts each step and the contacts in, finished and left by reason, equal to the records', async () => {
    const res = await api(agent, 'get', `/drips/${dripId}/results`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: 3, finished: 0, left: { REPLIED: 1 } });
    const [first, second] = res.body.steps as Array<Record<string, unknown>>;
    expect(first).toMatchObject({ stepId: stepIds[0], position: 1, removed: false, sent: 2, delivered: 2, read: 1, clicked: 1, replied: 1, failed: 1, skipped: 1 });
    expect(second).toMatchObject({ stepId: stepIds[1], position: 2, sent: 0, delivered: 0, read: 0, clicked: 0, replied: 0, failed: 0, skipped: 0 });
    expect((await api(agent, 'get', '/drips/00000000-0000-7000-8000-000000000000/results')).status).toBe(404);
  });

  it('lists the contacts behind each count, with phones masked for agents', async () => {
    expect(await contactsOf('SENT')).toEqual([people.Reader!.id, people.Receiver!.id].sort());
    expect(await contactsOf('READ')).toEqual([people.Reader!.id]);
    expect(await contactsOf('CLICKED')).toEqual([people.Reader!.id]);
    expect(await contactsOf('REPLIED')).toEqual([people.Reader!.id]);
    expect(await contactsOf('FAILED')).toEqual([people.Failure!.id]);
    expect(await contactsOf('SKIPPED')).toEqual([people.Unknown!.id]);
    const masked = await api(agent, 'get', `/drips/${dripId}/results/contacts?stepId=${stepIds[0]}&metric=SENT`);
    expect(masked.body.total).toBe(2);
    for (const row of masked.body.items as Array<{ phone: string }>) expect(row.phone).not.toMatch(/^\+971/);
    expect((await api(manager, 'get', `/drips/${dripId}/results/contacts?stepId=${stepIds[0]}&metric=OPENED`)).status).toBe(422);
  });

  it('exports the contacts behind a count', async () => {
    expect((await api(agent, 'get', `/drips/${dripId}/results/export?stepId=${stepIds[0]}&metric=SENT`)).status).toBe(403);
    const csv = await api(manager, 'get', `/drips/${dripId}/results/export?stepId=${stepIds[0]}&metric=SENT`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('phone,name');
    expect(lines.slice(1).sort()).toEqual([`${people.Reader!.phoneE164},Reader`, `${people.Receiver!.phoneE164},Receiver`].sort());
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', targetId: dripId } })).toBe(1);
  });
});
