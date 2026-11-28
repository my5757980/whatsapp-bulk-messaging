import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AudienceUploadProcessor } from '../../src/modules/campaigns/audience-upload.processor.js';
import { csvFile, digits, seedContact, seedNumber, seedRunningCampaign, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T058 (feature 009 US5, research R10, R11): replied counts that equal the 005 Replied group, the reply
// rate and the Replied filter, "send to every row" with copy_index and each row's values, and the export.
const HOUR = 3_600_000;

describe('Replies and "send to every row" (009 US5)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let templateId: string;

  const get = (url: string) => manager.agent.get(`/api${url}`);
  const send = (method: 'post' | 'patch', url: string, body: object = {}) => manager.agent[method](`/api${url}`).set('x-csrf-token', manager.csrf).send(body);
  const upload = async (campaignId: string, rows: string[]) => {
    const res = await manager.agent
      .post(`/api/campaigns/${campaignId}/audience-upload`)
      .set('x-csrf-token', manager.csrf)
      .field('phoneColumn', 'phone')
      .field('optInConfirmed', 'true')
      .field('optInSourceNote', 'Orders list')
      .attach('file', csvFile(['name,phone,order', ...rows]), { filename: 'orders.csv', contentType: 'text/csv' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    await ctx.app.get(AudienceUploadProcessor).process(res.body.id);
  };
  const draft = async (allowDuplicateRows: boolean) => {
    const res = await send('post', '/campaigns', { name: `Orders ${digits(5)}`, numberId: number.id, templateId, audienceType: 'UPLOAD', allowDuplicateRows, variableMapping: { 'BODY.1': { source: 'column', key: 'order' } } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    templateId = (await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' })).id;
  });
  afterAll(async () => ctx.close());

  it('counts replies like the Replied group, with the rate, the filter and the export columns', async () => {
    const now = Date.now();
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId, createdById: manager.userId, contacts: [] });
    // [name, status, delivered hours ago, read hours ago, reply hours after delivery]
    const people = [
      ['A', 'DELIVERED', 10, null, 2],
      ['B', 'READ', 20, 19, 1],
      ['C', 'DELIVERED', 100, null, 80],
      ['D', 'DELIVERED', 10, null, null],
      ['E', 'FAILED', null, null, null],
    ] as const;
    const ids: Record<string, string> = {};
    for (const [name, status, deliveredAgo, readAgo, replyAfter] of people) {
      const contact = await seedContact(ctx, uaePhone(), { name: `Reply ${name}` });
      const deliveredAt = deliveredAgo === null ? null : new Date(now - deliveredAgo * HOUR);
      const message = await ctx.prisma.message.create({
        data: {
          origin: 'CAMPAIGN',
          campaignId: campaign.id,
          contactId: contact.id,
          phoneE164: contact.phoneE164,
          recipientCountry: 'AE',
          numberId: number.id,
          templateId,
          status,
          sentAt: new Date(now - 120 * HOUR),
          deliveredAt,
          readAt: readAgo === null ? null : new Date(now - readAgo * HOUR),
          ...(status === 'FAILED' ? { failedAt: new Date(now - 119 * HOUR), failureCode: 131026 } : {}),
        },
      });
      ids[name] = message.id;
      if (replyAfter !== null && deliveredAt) {
        const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id, state: 'ACTIVE', lastCustomerMessageAt: new Date() } });
        await ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Thanks!', occurredAt: new Date(deliveredAt.getTime() + replyAfter * HOUR) } });
      }
    }

    const report = await get(`/campaigns/${campaign.id}/report`);
    expect(report.status).toBe(200);
    // A and B replied within 3 days; C replied after 3 days; D did not; E was never delivered.
    expect(report.body).toMatchObject({ replied: 2, replyRate: 0.5, multiMessageRecipients: 0, heldBack: 0 });
    const groups = await get(`/campaigns/${campaign.id}/retarget-groups`);
    const replied = (groups.body.groups as Array<{ status: string; count: number }>).find((g) => g.status === 'REPLIED');
    expect(replied?.count).toBe(report.body.replied);

    const repliedList = await get(`/campaigns/${campaign.id}/messages?replied=true`);
    expect(repliedList.status).toBe(200);
    expect((repliedList.body.items as Array<{ id: string }>).map((m) => m.id).sort()).toEqual([ids.A, ids.B].sort());
    expect(repliedList.body.page).toMatchObject({ total: 2 });
    const notReplied = await get(`/campaigns/${campaign.id}/messages?replied=false`);
    expect((notReplied.body.items as Array<{ id: string }>).map((m) => m.id).sort()).toEqual([ids.C, ids.D].sort());

    const csv = await get(`/campaigns/${campaign.id}/export`);
    expect(csv.status).toBe(200);
    const [header, ...lines] = String(csv.text).trim().split('\n');
    expect(header!.split(',').slice(-3)).toEqual(['replied', 'replied_at', 'clicks']);
    const row = (name: string) => lines.find((l) => l.includes(`Reply ${name}`))!.split(',');
    expect(row('A').slice(-3, -1)[0]).toBe('yes');
    expect(row('A').at(-2)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row('D').slice(-3)).toEqual(['no', '', '0']);
  });

  it('sends one message per row of a repeated number, with each row\'s values, when "send to every row" is on', async () => {
    const sara = uaePhone();
    const omar = uaePhone();
    const opted = uaePhone();
    await seedContact(ctx, opted, { name: 'Opted out', consentStatus: 'OPTED_OUT' });
    const rows = [`Sara,${sara},A-1`, `Sara,${sara},A-2`, `Omar,${omar},B-1`, `Sara,${sara},A-3`, `Opted,${opted},C-1`];

    const every = await draft(true);
    await upload(every, rows);
    const estimate = await send('post', `/campaigns/${every}/estimate`);
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
    expect(estimate.body).toMatchObject({ eligible: 4, excluded: { optedOut: 1, duplicate: 0 } });
    expect((await send('post', `/campaigns/${every}/launch`)).status).toBe(200);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: every }, orderBy: [{ phoneE164: 'asc' }, { copyIndex: 'asc' }] });
    const saras = messages.filter((m) => m.phoneE164 === sara);
    expect(saras.map((m) => [m.copyIndex, (m.resolvedParams as Record<string, string>)['BODY.1'], m.status])).toEqual([
      [0, 'A-1', 'PENDING'],
      [1, 'A-2', 'PENDING'],
      [2, 'A-3', 'PENDING'],
    ]);
    expect(messages.find((m) => m.phoneE164 === omar)).toMatchObject({ copyIndex: 0, status: 'PENDING' });
    expect(messages.find((m) => m.phoneE164 === opted)).toMatchObject({ status: 'SKIPPED', skipReason: 'OPTED_OUT' });
    expect((await get(`/campaigns/${every}/report`)).body.multiMessageRecipients).toBe(1);

    // Retarget groups hold distinct contacts.
    await ctx.prisma.message.updateMany({ where: { campaignId: every, status: 'PENDING' }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    const groups = await get(`/campaigns/${every}/retarget-groups`);
    expect((groups.body.groups as Array<{ status: string; count: number }>).find((g) => g.status === 'DELIVERED')?.count).toBe(2);

    // Off: one message per number, from its first row.
    const once = await draft(false);
    await upload(once, rows);
    const onceEstimate = await send('post', `/campaigns/${once}/estimate`);
    expect(onceEstimate.body).toMatchObject({ eligible: 2, excluded: { optedOut: 1, duplicate: 2 } });
    expect((await send('post', `/campaigns/${once}/launch`)).status).toBe(200);
    const single = await ctx.prisma.message.findMany({ where: { campaignId: once, phoneE164: sara } });
    expect(single.map((m) => [m.copyIndex, (m.resolvedParams as Record<string, string>)['BODY.1']])).toEqual([[0, 'A-1']]);
  });

  it('offers "send to every row" for uploaded lists only', async () => {
    const res = await send('post', '/campaigns', { name: `Filter ${digits(5)}`, numberId: number.id, templateId, audienceType: 'ALL_OPTED_IN', allowDuplicateRows: true, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } } });
    expect(res.status).toBe(201);
    const refused = await send('post', `/campaigns/${res.body.id}/launch`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('DUPLICATES_NEED_UPLOAD');
  });
});
