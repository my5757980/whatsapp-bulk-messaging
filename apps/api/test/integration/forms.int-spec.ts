import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearCommerce, formReply, seedOpenChat } from '../support/commerce.js';
import { FakeCommerceGraph } from '../support/fake-commerce-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T079 (feature 008 US7, FR-030 – FR-035, research R12): forms built, checked, published as versions to
// each WhatsApp account (Meta's validation errors mapped), sent in the window with a signed token, and
// answered: attributes by type, tags, consent FORM, journey and event; forged tokens are only plain
// replies; answers listed and exported; archive and delete; roles.

describe('WhatsApp Forms (008 US7)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeCommerceGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let tagId: string;
  const suffix = uniq('').slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const cityKey = `city_${suffix}`;
  const visitKey = `visit_${suffix}`;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const draft = (label = 'Your name') => ({
    screens: [
      { title: 'About you', button: 'Continue', fields: [{ key: 'name', type: 'shortText', label, required: true }, { key: 'email', type: 'email', label: 'Email', required: false }] },
      {
        title: 'Your visit',
        button: 'Submit',
        fields: [
          { key: 'city', type: 'dropdown', label: 'City', required: true, options: [{ id: 'dubai', title: 'Dubai' }, { id: 'sharjah', title: 'Sharjah' }] },
          { key: 'visit', type: 'date', label: 'Visit date', required: true },
          { key: 'consent', type: 'optIn', label: 'Send me offers on WhatsApp', required: false },
        ],
      },
    ],
  });
  const makeForm = async (name: string) => {
    const res = await api(manager, 'post', '/forms', { name, category: 'APPOINTMENT_BOOKING' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.id as string;
    const saved = await api(manager, 'put', `/forms/${id}`, { name, category: 'APPOINTMENT_BOOKING', draft: draft(), mapping: [{ fieldKey: 'city', attributeKey: cityKey }, { fieldKey: 'visit', attributeKey: visitKey }], tagIds: [tagId] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return id;
  };
  const answer = async (phone: string, answers: Record<string, unknown>) => ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, formReply(number.phoneNumberId, phone.slice(1), answers)));

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
    tagId = (await ctx.prisma.tag.create({ data: { name: uniq('booked-') } })).id;
    await ctx.prisma.attributeDefinition.create({ data: { key: cityKey, label: 'City', type: 'TEXT' } });
    await ctx.prisma.attributeDefinition.create({ data: { key: visitKey, label: 'Visit', type: 'DATE' } });
    const admin = await signIn(ctx, 'ADMIN');
    const endpoint = await admin.agent.post('/api/webhook-endpoints').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Forms hook '), url: `https://${uniq('forms')}.example.test/hooks`, eventTypes: ['form.submitted'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    graph = new FakeCommerceGraph(0).install();
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('builds, checks and publishes versions, and maps Meta validation errors', async () => {
    const id = await makeForm(`Booking ${suffix}`);
    expect((await api(manager, 'post', '/forms', { name: `Booking ${suffix}`, category: 'OTHER' })).status).toBe(409);
    expect((await api(manager, 'post', `/forms/${id}/check`)).body).toEqual({ problems: [] });

    graph.nextFlowErrors = [{ error: 'INVALID_PROPERTY_VALUE', message: 'The label is too long', pointers: [{ path: 'screens[0].layout.children[0].children[0] name' }] }];
    const refused = await api(manager, 'post', `/forms/${id}/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('META_REFUSED');
    expect(await ctx.prisma.formVersion.count({ where: { formId: id } })).toBe(0);

    const first = await api(manager, 'post', `/forms/${id}/publish`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ number: 1, status: 'PUBLISHED' });
    expect(first.body.accounts).toContainEqual({ wabaId: number.wabaId, status: 'PUBLISHED' });
    const published = [...graph.flows.values()].find((f) => f.wabaId === number.wabaId && f.status === 'PUBLISHED')!;
    expect(published.categories).toEqual(['APPOINTMENT_BOOKING']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'form.published', targetId: id } })).toBe(1);
    expect((await api(manager, 'post', `/forms/${id}/publish`)).body.code).toBe('NO_CHANGES');

    await api(manager, 'put', `/forms/${id}`, { name: `Booking ${suffix}`, category: 'APPOINTMENT_BOOKING', draft: draft('Full name'), mapping: [], tagIds: [] });
    const second = await api(manager, 'post', `/forms/${id}/publish`);
    expect(second.body).toMatchObject({ number: 2 });
    const form = await api(manager, 'get', `/forms/${id}`);
    expect(form.body).toMatchObject({ status: 'PUBLISHED', currentVersion: 2, changedSincePublish: false });
    expect(form.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it('sends a published form in the window and saves a valid answer with attributes, tags, consent and the event', async () => {
    const id = await makeForm(`Visit ${suffix}`);
    const { conversation, contact } = await seedOpenChat(ctx, { numberId: number.id });
    expect((await api(manager, 'post', `/inbox/conversations/${conversation.id}/forms`, { formId: id, body: 'Book a visit', cta: 'Book now' })).body.code).toBe('FORM_NOT_PUBLISHED');
    await api(manager, 'post', `/forms/${id}/publish`);
    const sent = await api(manager, 'post', `/inbox/conversations/${conversation.id}/forms`, { formId: id, header: 'Bookings', body: 'Book a visit', cta: 'Book now' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.body.chatItemId } });
    expect(item.contentType).toBe('FORM');
    const token = String((item.payload as Record<string, unknown>).token);
    expect(token).toMatch(/^wf1\./);

    const closed = await seedOpenChat(ctx, { numberId: number.id, minutesAgo: 25 * 60 });
    expect((await api(manager, 'post', `/inbox/conversations/${closed.conversation.id}/forms`, { formId: id, body: 'Book', cta: 'Book' })).body.code).toBe('WINDOW_CLOSED');

    // The opt-in field gives consent only to someone who has not opted in yet.
    await ctx.prisma.contact.update({ where: { id: contact.id }, data: { consentStatus: 'UNKNOWN' } });
    await answer(contact.phoneE164, { flow_token: token, name: 'Sara', email: 'not-an-email', city: 'dubai', visit: '2026-12-01', consent: true });
    const saved = await ctx.prisma.formAnswer.findFirstOrThrow({ where: { formId: id, contactId: contact.id } });
    expect(saved).toMatchObject({ source: 'INBOX', answers: { name: 'Sara', city: 'dubai', visit: '2026-12-01', consent: true } });
    expect(saved.problems).toEqual([{ fieldKey: 'email', reason: 'not an email address' }]);
    const after = await ctx.prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.attributes).toMatchObject({ [cityKey]: 'dubai', [visitKey]: '2026-12-01' });
    expect(after.consentStatus).toBe('OPTED_IN');
    expect(after.consentSource).toBe('FORM');
    expect(await ctx.prisma.contactTag.count({ where: { contactId: contact.id, tagId } })).toBe(1);
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: conversation.id, type: 'FORM_SUBMITTED' } })).toBe(1);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'form.submitted' } })).toBeGreaterThan(0);

    const list = await api(manager, 'get', `/forms/${id}/answers`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: saved.id, versionNumber: 1, source: 'INBOX' })]);
    const csv = await api(manager, 'get', `/forms/${id}/answers/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('submitted_at');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'form_answers.exported', targetId: id } })).toBe(1);
  });

  it('keeps forged tokens and other contacts’ tokens as plain replies', async () => {
    const id = await makeForm(`Forged ${suffix}`);
    await api(manager, 'post', `/forms/${id}/publish`);
    const { conversation, contact } = await seedOpenChat(ctx, { numberId: number.id });
    const sent = await api(manager, 'post', `/inbox/conversations/${conversation.id}/forms`, { formId: id, body: 'Book', cta: 'Book' });
    const token = String(((await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.body.chatItemId } })).payload as Record<string, unknown>).token);
    const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    await answer(contact.phoneE164, { flow_token: forged, name: 'Mallory', city: 'dubai', visit: '2026-12-01' });
    const other = await seedOpenChat(ctx, { numberId: number.id });
    await answer(other.contact.phoneE164, { flow_token: token, name: 'Eve', city: 'dubai', visit: '2026-12-01' });
    expect(await ctx.prisma.formAnswer.count({ where: { formId: id } })).toBe(0);
    expect(await ctx.prisma.chatMessage.count({ where: { contentType: 'FORM_REPLY', conversation: { contactId: { in: [contact.id, other.contact.id] } } } })).toBe(2);
  });

  it('archives (deprecating its flows), deletes only drafts, and keeps manage routes from agents', async () => {
    const id = await makeForm(`Archive ${suffix}`);
    await api(manager, 'post', `/forms/${id}/publish`);
    expect((await api(manager, 'delete', `/forms/${id}`)).body.code).toBe('PUBLISHED_USE_ARCHIVE');
    const archived = await api(manager, 'post', `/forms/${id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('ARCHIVED');
    expect([...graph.flows.values()].filter((f) => f.status === 'DEPRECATED').length).toBeGreaterThan(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'form.archived', targetId: id } })).toBe(1);

    const draftOnly = await api(manager, 'post', '/forms', { name: `Scratch ${suffix}`, category: 'OTHER' });
    expect((await api(manager, 'delete', `/forms/${draftOnly.body.id}`)).status).toBe(204);

    expect((await api(agent, 'post', '/forms', { name: `Agent ${suffix}`, category: 'OTHER' })).status).toBe(403);
    const seen = await api(agent, 'get', '/forms');
    expect(seen.status).toBe(200);
    expect(seen.body.items.every((f: { status: string }) => f.status === 'PUBLISHED')).toBe(true);
  });
});
