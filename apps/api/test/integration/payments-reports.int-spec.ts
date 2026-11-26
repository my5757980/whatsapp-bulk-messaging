import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentsTickProcessor } from '../../src/modules/payments/tick/payments-tick.processor.js';
import { clearCommerce, seedGateway, seedOpenChat, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T055 (feature 008 US4, FR-017 - FR-020, research R6): reminders at their times, once each and only
// for delivered waiting requests; totals by status, day and source with test requests left out; the
// CSV export (audited); and the Paid / Not paid retarget groups of a payment campaign.

const MIN = 60_000;

describe('Payment reminders, totals, export and retargeting (008 US4)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let reminderTemplateId: string;
  let numberId: string;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const mapping = { 'BODY.1': { source: 'payment', key: 'amount' }, 'BODY.2': { source: 'payment', key: 'expires' } };
  const tick = (at: Date) => ctx.app.get(PaymentsTickProcessor).runTick(at);
  const remindersTo = (contactId: string) => ctx.prisma.message.count({ where: { contactId, origin: 'PAYMENTS', templateId: reminderTemplateId } });

  async function request(minutes = 600) {
    const { contact, conversation } = await seedOpenChat(ctx, { numberId });
    const res = await api(admin, 'post', `/inbox/conversations/${conversation.id}/payment-requests`, { amountMinor: 15000, description: 'Order 77', expiresInMinutes: minutes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: String(res.body.id) } });
    return { contact, conversation, row };
  }
  const delivered = (chatItemId: string | null) => ctx.prisma.chatMessage.update({ where: { id: chatItemId! }, data: { status: 'DELIVERED' } });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx);
    numberId = number.id;
    const base = process.env.PUBLIC_LINK_BASE_URL as string;
    reminderTemplateId = (
      await seedTemplate(ctx, number.wabaId, {
        components: [
          { type: 'BODY', text: 'A reminder: {{1}} is still due, the link expires {{2}}.', example: { body_text: [['AED 150.00', '26 Nov 18:00']] } },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: `${base}/p/{{1}}`, example: [`${base}/p/AbCdEf1234`] }] },
        ],
        variables: [
          { key: 'BODY.1', example: 'AED 150.00' },
          { key: 'BODY.2', example: '26 Nov 18:00' },
          { key: 'BUTTON.0.1', example: 'AbCdEf1234' },
        ],
      })
    ).id;
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    new FakeStripe().install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx, {
      reminders: [
        { beforeMinutes: 120, templateId: reminderTemplateId, mapping },
        { beforeMinutes: 30, templateId: reminderTemplateId, mapping },
      ],
    });
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  describe('reminders', () => {
    it('sends both reminders at their times, once each', async () => {
      const { contact, row } = await request();
      const expires = row.expiresAt.getTime();
      expect(row.nextReminderAt?.getTime()).toBe(expires - 120 * MIN);
      await delivered(row.chatItemId);

      expect((await tick(new Date(expires - 121 * MIN))).reminders).toBe(0);
      expect((await tick(new Date(expires - 119 * MIN))).reminders).toBe(1);
      expect((await tick(new Date(expires - 119 * MIN))).reminders).toBe(0);
      expect(await remindersTo(contact.id)).toBe(1);
      const after = await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({ remindersSent: 1, chatItemId: row.chatItemId });
      expect(after.nextReminderAt?.getTime()).toBe(expires - 30 * MIN);

      expect((await tick(new Date(expires - 29 * MIN))).reminders).toBe(1);
      expect(await remindersTo(contact.id)).toBe(2);
      expect(await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ remindersSent: 2, nextReminderAt: null });
    });

    it('skips requests that were not delivered, and stops when paid or cancelled', async () => {
      const notDelivered = await request();
      const expires = notDelivered.row.expiresAt.getTime();
      expect((await tick(new Date(expires - 119 * MIN))).reminders).toBe(0);
      expect(await remindersTo(notDelivered.contact.id)).toBe(0);

      const cancelled = await request();
      await delivered(cancelled.row.chatItemId);
      expect((await api(admin, 'post', `/payments/requests/${cancelled.row.id}/cancel`)).status).toBe(200);
      expect((await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: cancelled.row.id } })).nextReminderAt).toBeNull();
      await tick(new Date(cancelled.row.expiresAt.getTime() - 119 * MIN));
      expect(await remindersTo(cancelled.contact.id)).toBe(0);
    });

    it('skips a marketing reminder for an opted-out contact', async () => {
      await ctx.prisma.template.update({ where: { id: reminderTemplateId }, data: { category: 'MARKETING' } });
      try {
        const { contact, row } = await request();
        await delivered(row.chatItemId);
        await ctx.prisma.contact.update({ where: { id: contact.id }, data: { consentStatus: 'OPTED_OUT' } });
        expect((await tick(new Date(row.expiresAt.getTime() - 119 * MIN))).reminders).toBe(0);
        expect(await remindersTo(contact.id)).toBe(0);
      } finally {
        await ctx.prisma.template.update({ where: { id: reminderTemplateId }, data: { category: 'UTILITY' } });
      }
    });

    it('refuses a reminder at or after the default expiry', async () => {
      const base = { maxAmountMinor: 500_000, defaultExpiryMinutes: 60, requestRoles: ['ADMIN', 'MANAGER'], sessionText: '{description}: {amount}', buttonText: 'Pay now', templateId: null, templateMapping: {}, chatOrderMode: 'REVIEW', chatOrderExpiryMinutes: 1440, chatOrderTagId: null };
      const res = await api(admin, 'put', '/payments/settings', { ...base, reminders: [{ beforeMinutes: 60, templateId: reminderTemplateId, mapping }] });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/before the link expires/);
    });
  });

  describe('totals and export', () => {
    async function seedFive() {
      const contact = await seedContact(ctx, uaePhone(), { name: 'Totals Customer' });
      const base = { contactId: contact.id, phoneE164: contact.phoneE164, currency: 'aed', description: 'Totals', expiresAt: new Date(Date.now() + 3_600_000) };
      let n = 0;
      const make = (data: Record<string, unknown>) => ctx.prisma.paymentRequest.create({ data: { ...base, code: `Tot${String(++n).padStart(7, '0')}${uniq('').slice(-3)}`.slice(0, 16), source: 'INBOX', createdById: admin.userId, ...data } as never });
      await make({ amountMinor: 10_000n, status: 'PAID', paidAt: new Date(), paidAmountMinor: 10_000n });
      await make({ amountMinor: 20_000n, status: 'PAID', paidAt: new Date(), paidAmountMinor: 20_000n, refundedMinor: 10_000n, refundedAt: new Date() });
      await make({ amountMinor: 5_000n, status: 'WAITING' });
      await make({ amountMinor: 7_000n, status: 'WAITING', source: 'FLOW', createdById: null });
      await make({ amountMinor: 3_000n, status: 'EXPIRED', expiredAt: new Date() });
      await make({ amountMinor: 99_999n, status: 'PAID', paidAmountMinor: 99_999n, isTest: true });
      return contact;
    }
    const today = async () => {
      const zone = (await ctx.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } }))?.defaultTimezone ?? 'UTC';
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    };

    it('totals by status, day and source, without test requests, with the filters', async () => {
      await seedFive();
      const day = await today();
      const res = await api(manager, 'get', `/payments/summary?from=${day}&to=${day}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const totals = { requestedMinor: 45_000, requestedCount: 5, paidMinor: 30_000, paidCount: 2, waitingMinor: 12_000, waitingCount: 2, expiredMinor: 3_000, expiredCount: 1, refundedMinor: 10_000, refundedCount: 1 };
      expect(res.body).toMatchObject({ currency: 'aed', totals });
      expect(res.body.days).toEqual([{ day, ...totals }]);
      expect(res.body.sources.map((s: { source: string; requestedCount: number }) => [s.source, s.requestedCount])).toEqual([
        ['INBOX', 4],
        ['FLOW', 1],
      ]);
      expect((await api(manager, 'get', `/payments/summary?from=${day}&to=${day}&source=FLOW`)).body.totals).toMatchObject({ requestedCount: 1, waitingMinor: 7_000 });
      expect((await api(manager, 'get', `/payments/summary?from=${day}&to=${day}&createdById=${admin.userId}`)).body.totals).toMatchObject({ requestedCount: 4 });
      expect((await api(manager, 'get', '/payments/summary?from=2026-11-20&to=2026-11-01')).status).toBe(422);
      expect((await api(agent, 'get', `/payments/summary?from=${day}&to=${day}`)).status).toBe(403);
    });

    it('exports the requests as CSV and records the export', async () => {
      const contact = await seedFive();
      const day = await today();
      const res = await api(manager, 'get', `/payments/export.csv?from=${day}&to=${day}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      const lines = String(res.text).trim().split('\n');
      expect(lines[0]).toMatch(/^created_at,reference,description,amount_minor/);
      expect(lines).toHaveLength(6);
      expect(res.text).toContain(contact.phoneE164);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'payments.exported', actorUserId: manager.userId } })).toBe(1);
      expect((await api(agent, 'get', `/payments/export.csv?from=${day}&to=${day}`)).status).toBe(403);
    });
  });

  it('gives a payment campaign its Paid and Not paid groups', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contacts: Array<Awaited<ReturnType<typeof seedContact>>> = [];
    for (let i = 0; i < 3; i++) contacts.push(await seedContact(ctx, uaePhone()));
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts });
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { paymentConfig: { amount: { source: 'static', minor: 5000 }, description: 'Invoice', expiryMinutes: 1440 }, state: 'COMPLETED' } });
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id }, orderBy: { phoneE164: 'asc' } });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const statuses = ['PAID', 'WAITING', 'EXPIRED'] as const;
    for (const [i, m] of messages.entries()) {
      await ctx.prisma.paymentRequest.create({
        data: { code: `Rtg${i}${uniq('').slice(-8)}`.slice(0, 16), contactId: m.contactId, phoneE164: m.phoneE164, amountMinor: 5000n, currency: 'aed', description: 'Invoice', expiresAt: new Date(Date.now() + 3_600_000), status: statuses[i]!, source: 'CAMPAIGN', campaignId: campaign.id, messageId: m.id },
      });
    }
    const groups = await api(manager, 'get', `/campaigns/${campaign.id}/retarget-groups`);
    expect(groups.status).toBe(200);
    const size = (status: string) => groups.body.groups.find((g: { status: string; count: number }) => g.status === status)?.count;
    expect(size('PAID')).toBe(1);
    expect(size('NOT_PAID')).toBe(2);
    const draft = await api(manager, 'post', `/campaigns/${campaign.id}/retarget`, { status: 'NOT_PAID' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ retargetStatus: 'NOT_PAID', paymentConfig: { description: 'Invoice' } });
    const payers = await api(manager, 'post', `/campaigns/${campaign.id}/retarget`, { status: 'PAID' });
    expect(payers.body.paymentConfig).toBeNull();
  });
});
