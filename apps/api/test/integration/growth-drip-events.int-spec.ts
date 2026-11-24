import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DripEvents } from '../../src/modules/growth/drips/drip-events.js';
import { DripTickProcessor } from '../../src/modules/growth/drips/drip-tick.processor.js';
import { ImportProcessor } from '../../src/modules/imports/import.processor.js';
import { csvFile, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T050 (feature 005, US5, FR-024 - FR-028, research R8): starting events enrol contacts once through
// the outbox, only into active drips; stop tags and clicks make contacts leave.
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

describe('Drip starting events (005 US5)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let numberId: string;
  let templateId: string;
  const tags: Record<string, { id: string; name: string }> = {};

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) =>
    method === 'get' ? who.agent.get(`/api${url}`) : who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const tick = () => ctx.app.get(DripTickProcessor).tick();
  const joined = (dripId: string, contactId: string) => ctx.prisma.dripEnrolment.findMany({ where: { dripId, contactId } });
  const step = { templateId: '', variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes: 60 };

  /** A drip with one step and the given starting events, activated unless `draft`. */
  async function drip(triggers: object[], settings: object = {}, draft = false) {
    const created = await api(manager, 'post', '/drips', { name: `Events ${uniq('')}`, numberId });
    const id = created.body.id as string;
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps: [{ ...step, templateId }] })).status).toBe(200);
    expect((await api(manager, 'patch', `/drips/${id}`, { triggers, ...settings })).status).toBe(200);
    if (!draft) expect((await api(manager, 'post', `/drips/${id}/activate`)).status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    numberId = number.id;
    templateId = (await seedTemplate(ctx, number.wabaId)).id;
    for (const key of ['lead', 'stop', 'other']) {
      const name = uniq(`evt-${key}-`).toLowerCase();
      tags[key] = await ctx.prisma.tag.create({ data: { name } });
    }
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('enrols once when a chosen tag is added by a member, in bulk or by an import', async () => {
    const id = await drip([{ kind: 'TAG_ADDED', tagId: tags.lead!.id }]);
    const [a, b] = [await seedContact(ctx, uaePhone()), await seedContact(ctx, uaePhone())];

    expect((await api(manager, 'patch', `/contacts/${a.id}`, { tags: [tags.lead!.name] })).status).toBe(200);
    expect((await api(manager, 'post', '/contacts/bulk', { contactIds: [a.id, b.id], action: 'ADD_TAG', tag: tags.lead!.name })).status).toBe(200);
    // A tag that is not a starting event does nothing.
    expect((await api(manager, 'patch', `/contacts/${a.id}`, { tags: [tags.lead!.name, tags.other!.name] })).status).toBe(200);
    await tick();
    expect(await joined(id, a.id)).toEqual([expect.objectContaining({ status: 'ACTIVE', joinedVia: 'TAG_ADDED', currentPosition: 1 })]);
    expect(await joined(id, b.id)).toHaveLength(1);

    const phone = uaePhone();
    const upload = await admin.agent
      .post('/api/imports')
      .set('x-csrf-token', admin.csrf)
      .field('mapping', JSON.stringify({ phone: 'phone', tags: 'tags' }))
      .attach('file', csvFile(['phone,tags', `${phone},${tags.lead!.name}`]), { filename: 'contacts.csv', contentType: 'text/csv' });
    expect(upload.status, JSON.stringify(upload.body)).toBe(202);
    await ctx.app.get(ImportProcessor).process(upload.body.id);
    await tick();
    const imported = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(await joined(id, imported.id)).toHaveLength(1);
  });

  it('enrols on opt-in and on new contacts from an import or the public API, but not existing ones', async () => {
    const optIn = await drip([{ kind: 'OPTED_IN' }]);
    const imported = await drip([{ kind: 'IMPORTED' }]);
    const viaApi = await drip([{ kind: 'API_CREATED' }]);

    const unknown = await seedContact(ctx, uaePhone(), { consentStatus: 'UNKNOWN' });
    expect((await api(manager, 'patch', `/contacts/${unknown.id}`, { consentStatus: 'OPTED_IN', consentSourceNote: 'Asked at the counter' })).status).toBe(200);

    const fresh = uaePhone();
    const existing = await seedContact(ctx, uaePhone());
    const upload = await admin.agent
      .post('/api/imports')
      .set('x-csrf-token', admin.csrf)
      .field('mapping', JSON.stringify({ phone: 'phone' }))
      .attach('file', csvFile(['phone', fresh, existing.phoneE164]), { filename: 'contacts.csv', contentType: 'text/csv' });
    await ctx.app.get(ImportProcessor).process(upload.body.id);

    const key = (await admin.agent.post('/api/api-keys').set('x-csrf-token', admin.csrf).send({ name: `Drip key ${uniq('')}` })).body as { secret: string };
    const template = await ctx.prisma.template.findUniqueOrThrow({ where: { id: templateId } });
    const apiPhone = uaePhone();
    const sent = await request(ctx.server())
      .post('/api/v1/messages')
      .set('authorization', `Bearer ${key.secret}`)
      .send({ numberId, to: apiPhone, template: { name: template.name, language: template.language }, params: { 'BODY.1': 'Sara' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await request(ctx.server())
      .post('/api/v1/messages')
      .set('authorization', `Bearer ${key.secret}`)
      .send({ numberId, to: existing.phoneE164, template: { name: template.name, language: template.language }, params: { 'BODY.1': 'Sara' } });
    await tick();

    expect(await joined(optIn, unknown.id)).toEqual([expect.objectContaining({ joinedVia: 'OPTED_IN' })]);
    const freshContact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: fresh } });
    expect(await joined(imported, freshContact.id)).toEqual([expect.objectContaining({ joinedVia: 'IMPORTED' })]);
    expect(await joined(imported, existing.id)).toEqual([]);
    const apiContact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: apiPhone } });
    expect(await joined(viaApi, apiContact.id)).toEqual([expect.objectContaining({ joinedVia: 'API_CREATED' })]);
    expect(await joined(viaApi, existing.id)).toEqual([]);
  });

  it('enrols once on a click on a chosen campaign, or any campaign', async () => {
    const base = process.env.PUBLIC_LINK_BASE_URL as string;
    const campaigns = [];
    for (let i = 0; i < 2; i += 1) {
      campaigns.push(
        await ctx.prisma.campaign.create({
          data: { name: `Click source ${uniq('')}`, numberId, templateId, state: 'COMPLETED', audienceType: 'ALL_OPTED_IN', createdById: manager.userId },
        }),
      );
    }
    const chosen = await drip([{ kind: 'LINK_CLICKED', campaignId: campaigns[0]!.id }]);
    const any = await drip([{ kind: 'LINK_CLICKED', campaignId: null }]);
    const contact = await seedContact(ctx, uaePhone());

    /** A tracked link of the campaign for the contact, opened twice. */
    const click = async (campaignId: string) => {
      const target = await ctx.prisma.trackedLinkTarget.create({ data: { campaignId, variableKey: 'BODY.1', destination: 'https://shop.example/x' } });
      const message = await ctx.prisma.message.create({
        data: { origin: 'CAMPAIGN', campaignId, contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId, templateId, status: 'DELIVERED' },
      });
      const code = `Ev${uniq('').slice(0, 8)}`;
      await ctx.prisma.trackedLink.create({ data: { code, targetId: target.id, messageId: message.id, contactId: contact.id } });
      for (let i = 0; i < 2; i += 1) expect((await request(ctx.server()).get(`/l/${code}`).set('User-Agent', PHONE_UA)).status).toBe(302);
      expect(base).toBeTruthy();
    };
    await click(campaigns[0]!.id);
    await tick();
    expect(await joined(chosen, contact.id)).toHaveLength(1);
    expect(await joined(any, contact.id)).toHaveLength(1);

    const other = await drip([{ kind: 'LINK_CLICKED', campaignId: campaigns[0]!.id }]);
    await click(campaigns[1]!.id);
    await tick();
    expect(await joined(other, contact.id)).toEqual([]);
  });

  it('enrols nobody into draft or paused drips, and does not replay their events later', async () => {
    const draftId = await drip([{ kind: 'TAG_ADDED', tagId: tags.other!.id }], {}, true);
    const contact = await seedContact(ctx, uaePhone());
    await api(manager, 'patch', `/contacts/${contact.id}`, { tags: [tags.other!.name] });
    await tick();
    expect((await api(manager, 'post', `/drips/${draftId}/activate`)).status).toBe(200);
    await tick();
    expect(await joined(draftId, contact.id)).toEqual([]);
  });

  it('lets contacts leave on a stop tag or a click on the drip, and writes no event when the change is rolled back', async () => {
    const id = await drip([{ kind: 'TAG_ADDED', tagId: tags.lead!.id }], { stopTagIds: [tags.stop!.id], leaveOnClick: true });
    const [a, b] = [await seedContact(ctx, uaePhone()), await seedContact(ctx, uaePhone())];
    await api(manager, 'post', '/contacts/bulk', { contactIds: [a.id, b.id], action: 'ADD_TAG', tag: tags.lead!.name });
    await tick();

    await api(manager, 'patch', `/contacts/${a.id}`, { tags: [tags.lead!.name, tags.stop!.name] });
    expect((await joined(id, a.id))[0]).toMatchObject({ status: 'LEFT', leftReason: 'STOP_TAG' });

    // b opens a tracked link of the drip's step.
    const stepId = (await ctx.prisma.dripStep.findFirstOrThrow({ where: { dripId: id } })).id;
    const target = await ctx.prisma.trackedLinkTarget.create({ data: { dripStepId: stepId, variableKey: 'BODY.1', destination: 'https://shop.example/drip' } });
    const message = await ctx.prisma.message.create({
      data: { origin: 'DRIP', contactId: b.id, phoneE164: b.phoneE164, recipientCountry: 'AE', numberId, templateId, status: 'DELIVERED', dripStepId: stepId },
    });
    const code = `Lv${uniq('').slice(0, 8)}`;
    await ctx.prisma.trackedLink.create({ data: { code, targetId: target.id, messageId: message.id, contactId: b.id } });
    expect((await request(ctx.server()).get(`/l/${code}`).set('User-Agent', PHONE_UA)).status).toBe(302);
    expect((await joined(id, b.id))[0]).toMatchObject({ status: 'LEFT', leftReason: 'CLICKED' });

    const before = await ctx.prisma.dripEvent.count();
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await ctx.app.get(DripEvents).recordTagsAdded(tx, a.id, [tags.lead!.id]);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await ctx.prisma.dripEvent.count()).toBe(before);
  });
});
