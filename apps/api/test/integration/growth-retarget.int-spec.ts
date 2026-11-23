import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T027 (feature 005, US2, FR-010 - FR-012, research R6): retarget groups with their sizes, and drafts
// whose launch snapshot is the group as it stands then, minus opted-out and deleted contacts.
const HOUR = 3_600_000;

describe('Retargeting by click, reply and held back (005 US2)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let sourceId: string;
  let numberId: string;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;
  const who: Record<string, string> = {};

  const api = (user: SignedInAgent, method: 'get' | 'post', url: string, body?: object) =>
    method === 'get' ? user.agent.get(`/api${url}`) : user.agent.post(`/api${url}`).set('X-CSRF-Token', user.csrf).send(body ?? {});

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx);
    numberId = number.id;
    const template = await seedTemplate(ctx, number.wabaId, {
      components: [
        { type: 'BODY', text: 'Hi {{1}}, our sale is on.' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: `${base}/{{1}}`, example: [`${base}/AbCdEf1234`] }] },
      ],
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BUTTON.0.1', example: `${base}/AbCdEf1234` },
      ],
    });
    const source = await ctx.prisma.campaign.create({
      data: {
        name: `Eid offer ${uniq('')}`,
        numberId,
        templateId: template.id,
        state: 'COMPLETED',
        audienceType: 'ALL_OPTED_IN',
        variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
        launchedAt: new Date(Date.now() - 120 * HOUR),
        completedAt: new Date(Date.now() - 100 * HOUR),
        createdById: manager.userId,
        trackedLinkTargets: { create: { variableKey: 'BUTTON.0.1', destination: 'https://shop.example/eid', addCampaignTags: true } },
      },
      include: { trackedLinkTargets: true },
    });
    sourceId = source.id;
    const target = source.trackedLinkTargets[0]!;

    const now = Date.now();
    const recipients = [
      // name, status, delivered hours ago, read hours ago, failure code, clicked, reply offset from delivery (hours)
      ['A', 'DELIVERED', 10, null, null, true, 2],
      ['B', 'READ', 100, 99, null, false, 80],
      ['C', 'READ', 10, 9, null, true, -5],
      ['D', 'DELIVERED', 10, null, null, false, null],
      ['E', 'FAILED', null, null, 131049, false, null],
      ['F', 'FAILED', null, null, 131026, false, null],
      ['G', 'SENT', null, null, null, false, null],
      ['H', 'DELIVERED', 10, null, null, true, null],
    ] as const;
    for (const [name, status, deliveredAgo, readAgo, failureCode, clicked, replyAfter] of recipients) {
      const contact = await seedContact(ctx, uaePhone(), { name: `Group ${name}` });
      who[name] = contact.id;
      const deliveredAt = deliveredAgo === null ? null : new Date(now - deliveredAgo * HOUR);
      const message = await ctx.prisma.message.create({
        data: {
          origin: 'CAMPAIGN',
          campaignId: sourceId,
          contactId: contact.id,
          phoneE164: contact.phoneE164,
          recipientCountry: 'AE',
          numberId,
          templateId: template.id,
          resolvedParams: { 'BODY.1': `Group ${name}`, 'BUTTON.0.1': `Code${name}0000`.slice(0, 10) },
          status,
          sentAt: new Date(now - 120 * HOUR),
          deliveredAt,
          readAt: readAgo === null ? null : new Date(now - readAgo * HOUR),
          failedAt: status === 'FAILED' ? new Date(now - 119 * HOUR) : null,
          failureCode,
        },
      });
      const link = await ctx.prisma.trackedLink.create({ data: { code: `Rt${uniq('').slice(0, 8)}`, targetId: target.id, messageId: message.id, contactId: contact.id } });
      if (clicked) {
        await ctx.prisma.linkClick.create({ data: { trackedLinkId: link.id, targetId: target.id, campaignId: sourceId, contactId: contact.id, device: 'MOBILE' } });
      }
      if (replyAfter !== null && deliveredAt) {
        const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId, state: 'ACTIVE', lastCustomerMessageAt: new Date() } });
        await ctx.prisma.chatMessage.create({
          data: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Is it still on?', occurredAt: new Date(deliveredAt.getTime() + replyAfter * HOUR) },
        });
      }
    }
    // D opted out since the campaign; H was deleted.
    await ctx.prisma.contact.update({ where: { id: who.D! }, data: { consentStatus: 'OPTED_OUT' } });
    await ctx.prisma.contact.delete({ where: { id: who.H! } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('shows the size of every group before anything is created', async () => {
    const res = await api(agent, 'get', `/campaigns/${sourceId}/retarget-groups`);
    expect(res.status).toBe(200);
    const sizes = Object.fromEntries((res.body.groups as Array<{ status: string; count: number; available: boolean }>).map((g) => [g.status, [g.count, g.available]]));
    expect(sizes).toEqual({
      FAILED: [2, true],
      NOT_READ: [3, true],
      READ: [2, true],
      DELIVERED: [4, true],
      CLICKED: [2, true],
      NOT_CLICKED: [2, true],
      REPLIED: [1, true],
      NOT_REPLIED: [3, true],
      HELD_BACK: [1, true],
    });
    expect((await api(agent, 'get', '/campaigns/00000000-0000-7000-8000-000000000000/retarget-groups')).status).toBe(404);
  });

  it.each([
    ['CLICKED', ['A', 'C'], [], /retarget clicked/],
    ['NOT_CLICKED', ['B'], ['D'], /retarget not clicked/],
    ['REPLIED', ['A'], [], /retarget replied/],
    ['NOT_REPLIED', ['B', 'C'], ['D'], /retarget not replied/],
    ['HELD_BACK', ['E'], [], /retarget held back/],
  ] as const)('launches a %s draft to exactly that group, minus contacts who opted out', async (status, pending, optedOut, name) => {
    const draft = await api(manager, 'post', `/campaigns/${sourceId}/retarget`, { status });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ state: 'DRAFT', audienceType: 'RETARGET', sourceCampaignId: sourceId, retargetStatus: status });
    expect(draft.body.name).toMatch(name);
    // The tracked button keeps its destination, so the draft can be sent as it is.
    const links = await api(manager, 'get', `/campaigns/${draft.body.id}/tracked-links`);
    expect(links.body.links).toEqual([{ id: expect.any(String), variableKey: 'BUTTON.0.1', destination: 'https://shop.example/eid', addCampaignTags: true }]);

    const launched = await api(manager, 'post', `/campaigns/${draft.body.id}/launch`, {});
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: draft.body.id } });
    const byStatus = (s: string) => messages.filter((m) => m.status === s).map((m) => m.contactId).sort();
    expect(byStatus('PENDING')).toEqual(pending.map((n) => who[n]).sort());
    expect(byStatus('SKIPPED')).toEqual(optedOut.map((n) => who[n]).sort());
  });

  it('keeps the 001 groups as they were', async () => {
    const draft = await api(manager, 'post', `/campaigns/${sourceId}/retarget`, { status: 'FAILED' });
    expect(draft.status).toBe(201);
    expect((await api(manager, 'post', `/campaigns/${draft.body.id}/launch`, {})).status).toBe(200);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: draft.body.id } });
    expect(messages.map((m) => m.contactId).sort()).toEqual([who.E, who.F].sort());
  });

  it('refuses groups of a campaign whose messages were removed, and checks permissions', async () => {
    expect((await api(agent, 'post', `/campaigns/${sourceId}/retarget`, { status: 'CLICKED' })).status).toBe(403);
    expect((await api(manager, 'post', `/campaigns/${sourceId}/retarget`, { status: 'OPENED' })).status).toBe(422);

    const purged = await ctx.prisma.campaign.create({
      data: { name: `Old campaign ${uniq('')}`, numberId, state: 'COMPLETED', audienceType: 'ALL_OPTED_IN', createdById: manager.userId, launchedAt: new Date(Date.now() - 400 * 24 * HOUR) },
    });
    const groups = await api(agent, 'get', `/campaigns/${purged.id}/retarget-groups`);
    expect(groups.status).toBe(200);
    expect((groups.body.groups as Array<{ available: boolean }>).every((g) => !g.available)).toBe(true);
    const refused = await api(manager, 'post', `/campaigns/${purged.id}/retarget`, { status: 'CLICKED' });
    expect(refused.status).toBe(409);
  });
});
