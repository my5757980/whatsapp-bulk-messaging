import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DripTickProcessor } from '../../src/modules/growth/drips/drip-tick.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { mockMetaSends, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T041 (feature 005, US4, FR-019 - FR-034): building drips, manual enrolment, the 30-second tick,
// quiet hours, leaving rules, step outcomes, self-pause, edits, live chat and the journey.
const HOUR = 3_600_000;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

describe('Drip campaigns (005 US4)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let admin: SignedInAgent;
  let numberId: string;
  let phoneNumberId: string;
  let utility: string;
  let marketing: string;
  let foreign: string;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) =>
    method === 'get' ? who.agent.get(`/api${url}`) : who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const tick = () => ctx.app.get(DripTickProcessor).tick();
  const step = (templateId: string, waitMinutes: number) => ({ templateId, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes });
  const makeDue = (dripId: string) => ctx.prisma.dripEnrolment.updateMany({ where: { dripId, status: 'ACTIVE' }, data: { nextDueAt: new Date(Date.now() - 60_000) } });
  const enrolment = (dripId: string, contactId: string) => ctx.prisma.dripEnrolment.findFirstOrThrow({ where: { dripId, contactId }, orderBy: { joinedAt: 'desc' } });
  const dripMessages = (dripId: string, contactId: string) =>
    ctx.prisma.message.findMany({ where: { contactId, dripStep: { dripId } }, include: { dripStep: true }, orderBy: { createdAt: 'asc' } });

  /** An active drip with the given steps and settings. */
  async function activeDrip(steps: object[], settings: object = {}) {
    const created = await api(manager, 'post', '/drips', { name: `Drip ${uniq('')}`, numberId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps })).status).toBe(200);
    if (Object.keys(settings).length) expect((await api(manager, 'patch', `/drips/${id}`, settings)).status).toBe(200);
    const activated = await api(manager, 'post', `/drips/${id}/activate`);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    return id;
  }

  async function enrolled(dripId: string, names: string[], overrides: Parameters<typeof seedContact>[2] = {}) {
    const contacts = [];
    for (const name of names) contacts.push(await seedContact(ctx, uaePhone(), { name, ...overrides }));
    const res = await api(manager, 'post', `/drips/${dripId}/enrolments`, { contactIds: contacts.map((c) => c.id) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return contacts;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    // Quiet hours are checked in the company time zone; these tests use UTC.
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { defaultTimezone: 'UTC' } });
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx, { sendRatePerSecond: 20 });
    numberId = number.id;
    phoneNumberId = number.phoneNumberId;
    utility = (await seedTemplate(ctx, number.wabaId, { name: `drip_utility_${uniq('').slice(0, 6)}` })).id;
    marketing = (await seedTemplate(ctx, number.wabaId, { name: `drip_marketing_${uniq('').slice(0, 6)}`, category: 'MARKETING' })).id;
    foreign = (await seedTemplate(ctx, `WABA_OTHER_${uniq('')}`, { name: `drip_foreign_${uniq('').slice(0, 6)}` })).id;
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('builds a drip, refuses bad steps and names, and lists what blocks activation', async () => {
    const name = `Welcome series ${uniq('')}`;
    const created = await api(manager, 'post', '/drips', { name, numberId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, status: 'DRAFT', number: { id: numberId }, steps: 0, quietHours: null, leaveOnReply: true, leaveOnClick: false, allowRejoin: false });
    expect(created.body.problems.map((p: { code: string }) => p.code)).toContain('NO_STEPS');
    const id = created.body.id as string;
    expect((await api(manager, 'post', '/drips', { name: name.toUpperCase(), numberId })).body.code).toBe('NAME_TAKEN');
    expect((await api(agent, 'post', '/drips', { name: `Agent ${uniq('')}`, numberId })).status).toBe(403);

    // Waits: zero only at the first step, otherwise 10 minutes to 30 days; templates of the drip's account.
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps: [step(utility, 0), step(utility, 5)] })).status).toBe(422);
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps: [step(utility, 0), step(utility, 0)] })).status).toBe(422);
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps: [step(foreign, 0)] })).status).toBe(422);
    expect((await api(manager, 'put', `/drips/${id}/steps`, { steps: Array.from({ length: 11 }, (_, i) => step(utility, i ? 10 : 0)) })).status).toBe(422);

    const saved = await api(manager, 'put', `/drips/${id}/steps`, {
      steps: [step(utility, 0), { templateId: utility, variableMapping: {}, waitMinutes: 60 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.stepList.map((s: { position: number; waitMinutes: number }) => [s.position, s.waitMinutes])).toEqual([
      [1, 0],
      [2, 60],
    ]);
    // Step 2 has an unmapped variable: activating is refused with the problem listed (FR-022).
    const blocked = await api(manager, 'post', `/drips/${id}/activate`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('ACTIVATION_BLOCKED');
    expect(blocked.body.problems).toEqual([expect.objectContaining({ code: 'VARIABLES_NOT_MAPPED', stepPosition: 2 })]);

    expect((await api(manager, 'patch', `/drips/${id}`, { quietHours: { from: '21:00', to: '21:00', days: EVERY_DAY } })).status).toBe(422);
    const settings = await api(manager, 'patch', `/drips/${id}`, { quietHours: { from: '21:00', to: '09:00', days: EVERY_DAY }, allowRejoin: true });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ quietHours: { from: '21:00', to: '09:00', days: EVERY_DAY }, allowRejoin: true });
    await api(manager, 'put', `/drips/${id}/steps`, { steps: [step(utility, 0), step(utility, 60)] });
    const active = await api(manager, 'post', `/drips/${id}/activate`);
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ status: 'ACTIVE', problems: [] });
    expect(await ctx.prisma.auditLog.count({ where: { targetId: id, action: { in: ['drip.created', 'drip.updated', 'drip.activated'] } } })).toBeGreaterThanOrEqual(3);

    const list = await api(agent, 'get', '/drips');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).find((d) => d.id === id)).toMatchObject({ status: 'ACTIVE', steps: 2, active: 0 });

    // A draft that never had contacts can be deleted; an active one cannot.
    expect((await api(manager, 'delete', `/drips/${id}`)).status).toBe(409);
    const draft = await api(manager, 'post', '/drips', { name: `Throwaway ${uniq('')}`, numberId });
    expect((await api(manager, 'delete', `/drips/${draft.body.id}`)).status).toBe(204);
  });

  it('enrols contacts by hand, counting who cannot join', async () => {
    const id = await activeDrip([step(utility, 0)]);
    const [a, b] = [await seedContact(ctx, uaePhone()), await seedContact(ctx, uaePhone())];
    const out = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' });
    const input = { contactIds: [a.id, b.id, out.id, '00000000-0000-7000-8000-000000000001'] };
    const preview = await api(manager, 'post', `/drips/${id}/enrolments/preview`, input);
    expect(preview.body).toEqual({ enrolled: 2, skippedOptedOut: 1, skippedAlreadyIn: 0, skippedNotFound: 1 });
    expect(await ctx.prisma.dripEnrolment.count({ where: { dripId: id } })).toBe(0);

    const done = await api(manager, 'post', `/drips/${id}/enrolments`, input);
    expect(done.body).toEqual({ enrolled: 2, skippedOptedOut: 1, skippedAlreadyIn: 0, skippedNotFound: 1 });
    expect((await api(manager, 'post', `/drips/${id}/enrolments`, { contactIds: [a.id] })).body).toMatchObject({ enrolled: 0, skippedAlreadyIn: 1 });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'drip.contacts_enrolled', targetId: id } })).toBe(2);

    // By a contact filter.
    const tag = await ctx.prisma.tag.create({ data: { name: uniq('drip') } });
    const tagged = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contactId: tagged.id, tagId: tag.id } });
    expect((await api(manager, 'post', `/drips/${id}/enrolments`, { filter: { all: [{ tag: tag.name }] } })).body).toMatchObject({ enrolled: 1 });

    const listed = await api(agent, 'get', `/drips/${id}/enrolments?status=ACTIVE`);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(3);
    expect(listed.body.items[0]).toMatchObject({ status: 'ACTIVE', joinedVia: 'MANUAL', currentPosition: 1 });
    for (const row of listed.body.items as Array<{ contact: { phone: string } }>) expect(row.contact.phone).not.toMatch(/^\+971/);

    const draft = await api(manager, 'post', '/drips', { name: `Draft ${uniq('')}`, numberId });
    expect((await api(manager, 'post', `/drips/${draft.body.id}/enrolments`, { contactIds: [a.id] })).body.code).toBe('NOT_ACTIVE');
    expect((await api(agent, 'post', `/drips/${id}/enrolments`, { contactIds: [a.id] })).status).toBe(403);
  });

  it('sends each step when it falls due, waits out quiet hours, and finishes', async () => {
    const id = await activeDrip([step(utility, 0), step(utility, 60)]);
    const [a] = await enrolled(id, ['Quiet A']);
    await tick();
    const first = await dripMessages(id, a!.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ origin: 'DRIP', status: 'QUEUED', resolvedParams: { 'BODY.1': 'Quiet A' } });
    expect(first[0]!.dripStep?.position).toBe(1);
    const afterOne = await enrolment(id, a!.id);
    expect(afterOne.currentPosition).toBe(2);
    expect(afterOne.nextDueAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(await ctx.prisma.dripStepSend.count({ where: { enrolmentId: afterOne.id, outcome: 'QUEUED' } })).toBe(1);

    // Step 2 falls due inside quiet hours: it waits until they end.
    await api(manager, 'patch', `/drips/${id}`, { quietHours: { from: hhmm(new Date(Date.now() - HOUR)), to: hhmm(new Date(Date.now() + HOUR)), days: EVERY_DAY } });
    await makeDue(id);
    await tick();
    expect(await dripMessages(id, a!.id)).toHaveLength(1);
    await api(manager, 'patch', `/drips/${id}`, { quietHours: null });
    await tick();
    expect(await dripMessages(id, a!.id)).toHaveLength(2);
    const finished = await enrolment(id, a!.id);
    expect(finished).toMatchObject({ status: 'FINISHED', nextDueAt: null });
    expect(finished.endedAt).toBeTruthy();
  });

  it('lets contacts leave at once when they reply, opt out, are blocked, deleted or removed', async () => {
    const id = await activeDrip([step(utility, 10), step(utility, 10)]);
    const [replier, outer, blockee, deletee, removee] = await enrolled(id, ['Replier', 'Outer', 'Blockee', 'Deletee', 'Removee']);

    const processor = ctx.app.get(WebhooksProcessor);
    await processor.process(await postSignedWebhook(ctx, webhook.inbound(phoneNumberId, replier!.phoneE164.slice(1), 'I will call you back later')));
    expect((await api(manager, 'patch', `/contacts/${outer!.id}`, { consentStatus: 'OPTED_OUT' })).status).toBe(200);
    expect((await api(manager, 'post', `/contacts/${blockee!.id}/block`)).status).toBeLessThan(300);
    const deletedEnrolment = await enrolment(id, deletee!.id);
    expect((await api(admin, 'delete', `/contacts/${deletee!.id}`)).status).toBe(204);
    const removeEnrolment = await enrolment(id, removee!.id);
    expect((await api(manager, 'delete', `/drips/${id}/enrolments/${removeEnrolment.id}`)).status).toBe(204);
    expect((await api(manager, 'delete', `/drips/${id}/enrolments/${removeEnrolment.id}`)).body.code).toBe('NOT_IN_DRIP');

    const reasons = async (contactId: string) => (await enrolment(id, contactId)).leftReason;
    expect(await reasons(replier!.id)).toBe('REPLIED');
    expect(await reasons(outer!.id)).toBe('OPTED_OUT');
    expect(await reasons(blockee!.id)).toBe('BLOCKED');
    expect((await ctx.prisma.dripEnrolment.findUniqueOrThrow({ where: { id: deletedEnrolment.id } })).leftReason).toBe('DELETED');
    expect(await reasons(removee!.id)).toBe('REMOVED');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'drip.contact_removed', targetId: id } })).toBe(1);

    // No step after the leaving event (SC-006), even when it was already due.
    await ctx.prisma.dripEnrolment.updateMany({ where: { dripId: id }, data: { nextDueAt: new Date(Date.now() - 60_000) } });
    await tick();
    expect(await ctx.prisma.message.count({ where: { dripStep: { dripId: id } } })).toBe(0);
  });

  it('skips marketing steps without an opt-in, ends the drip for invalid numbers and moves on after other failures', async () => {
    const id = await activeDrip([step(marketing, 0), step(utility, 10), step(utility, 10)]);
    const [unknown] = await enrolled(id, ['No opt-in'], { consentStatus: 'UNKNOWN' });
    const [invalid, other] = await enrolled(id, ['Invalid', 'Other failure']);
    await tick();

    const skipped = await enrolment(id, unknown!.id);
    expect(skipped.currentPosition).toBe(2);
    expect(await ctx.prisma.dripStepSend.findFirstOrThrow({ where: { enrolmentId: skipped.id } })).toMatchObject({ outcome: 'SKIPPED', skipReason: 'NO_OPT_IN', messageId: null });

    // Meta rejects one number as not on WhatsApp (131026) and fails another for a reason that may pass.
    const sent = await ctx.prisma.message.findMany({ where: { contactId: { in: [invalid!.id, other!.id] }, dripStep: { dripId: id } } });
    mockMetaSends(phoneNumberId, sent.map((m) => m.phoneE164!));
    for (const m of sent) expect((await ctx.app.get(SendProcessor).process(m.id, 1)).result).toBe('sent');
    const processor = ctx.app.get(WebhooksProcessor);
    const fail = async (phone: string, code: number) =>
      processor.process(
        await postSignedWebhook(ctx, webhook.status(phoneNumberId, `wamid.${phone.slice(1)}`, phone.slice(1), 'failed', { errors: [{ code, title: 'failed' }] })),
      );
    await fail(invalid!.phoneE164, 131026);
    await fail(other!.phoneE164, 131000);

    expect(await enrolment(id, invalid!.id)).toMatchObject({ status: 'LEFT', leftReason: 'INVALID_NUMBER' });
    expect(await enrolment(id, other!.id)).toMatchObject({ status: 'ACTIVE', currentPosition: 2 });
  });

  it('pauses itself when a template cannot be sent, and alerts managers', async () => {
    const paused = (await seedTemplate(ctx, (await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: numberId } })).wabaId, { name: `drip_soon_paused_${uniq('').slice(0, 6)}` })).id;
    const id = await activeDrip([step(paused, 0)]);
    await enrolled(id, ['Waiting']);
    await ctx.prisma.template.update({ where: { id: paused }, data: { status: 'PAUSED' } });
    await tick();
    const detail = await api(manager, 'get', `/drips/${id}`);
    expect(detail.body).toMatchObject({ status: 'PAUSED', pausedReason: 'TEMPLATE_UNAVAILABLE' });
    expect(await ctx.prisma.message.count({ where: { dripStep: { dripId: id } } })).toBe(0);
    expect(await ctx.prisma.notification.count({ where: { type: 'DRIP_PAUSED', userId: manager.userId } })).toBeGreaterThanOrEqual(1);
    // Resuming checks again.
    expect((await api(manager, 'post', `/drips/${id}/activate`)).status).toBe(422);
  });

  it('applies edits to steps not reached, holds sending while paused, archives, and allows joining again only when set', async () => {
    const id = await activeDrip([step(utility, 0), step(utility, 10), step(utility, 10)]);
    const [a] = await enrolled(id, ['Editor A']);
    await tick();
    expect((await enrolment(id, a!.id)).currentPosition).toBe(2);

    // Step 2 is removed while A waits for it: A moves on to the step after it (FR-023).
    const detail = await api(manager, 'get', `/drips/${id}`);
    const [s1, , s3] = detail.body.stepList as Array<{ id: string; template: { id: string } }>;
    const edited = await api(manager, 'put', `/drips/${id}/steps`, {
      steps: [
        { id: s1!.id, ...step(utility, 0) },
        { id: s3!.id, ...step(utility, 10) },
      ],
    });
    expect(edited.status).toBe(200);
    const moved = await enrolment(id, a!.id);
    expect(moved.currentPosition).toBe(2);

    // Paused: nothing is sent; resumed: the step that fell due goes out.
    expect((await api(manager, 'post', `/drips/${id}/pause`)).body.status).toBe('PAUSED');
    expect((await api(manager, 'post', `/drips/${id}/pause`)).body.code).toBe('NOT_ACTIVE');
    await makeDue(id);
    await tick();
    expect(await dripMessages(id, a!.id)).toHaveLength(1);
    expect((await api(manager, 'post', `/drips/${id}/activate`)).body.status).toBe('ACTIVE');
    await tick();
    const messages = await dripMessages(id, a!.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.dripStepId).toBe(s3!.id);
    expect((await enrolment(id, a!.id)).status).toBe('FINISHED');

    // Finished contacts join again only when the drip allows it.
    expect((await api(manager, 'post', `/drips/${id}/enrolments`, { contactIds: [a!.id] })).body).toMatchObject({ enrolled: 0, skippedAlreadyIn: 1 });
    await api(manager, 'patch', `/drips/${id}`, { allowRejoin: true });
    expect((await api(manager, 'post', `/drips/${id}/enrolments`, { contactIds: [a!.id] })).body).toMatchObject({ enrolled: 1 });

    // Archiving ends every active enrolment.
    const archived = await api(manager, 'post', `/drips/${id}/archive`);
    expect(archived.body.status).toBe('ARCHIVED');
    expect(await enrolment(id, a!.id)).toMatchObject({ status: 'LEFT', leftReason: 'ARCHIVED' });
    expect((await api(manager, 'patch', `/drips/${id}`, { name: `Renamed ${uniq('')}` })).body.code).toBe('DRIP_ARCHIVED');
    expect(await ctx.prisma.auditLog.count({ where: { targetId: id, action: { in: ['drip.paused', 'drip.resumed', 'drip.archived'] } } })).toBe(3);
  });

  it('refuses a 21st active drip', async () => {
    const active = await ctx.prisma.drip.count({ where: { status: 'ACTIVE' } });
    const filler = await Promise.all(
      Array.from({ length: Math.max(0, 20 - active) }, () => ctx.prisma.drip.create({ data: { name: `Filler ${uniq('')}`, numberId, status: 'ACTIVE' } })),
    );
    const created = await api(manager, 'post', '/drips', { name: `One too many ${uniq('')}`, numberId });
    await api(manager, 'put', `/drips/${created.body.id}/steps`, { steps: [step(utility, 0)] });
    const refused = await api(manager, 'post', `/drips/${created.body.id}/activate`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TOO_MANY_ACTIVE_DRIPS');
    await ctx.prisma.drip.updateMany({ where: { id: { in: filler.map((d) => d.id) } }, data: { status: 'ARCHIVED' } });
  });

  it('shows drip messages in live chat and joining and leaving in the journey', async () => {
    const id = await activeDrip([step(utility, 0), step(utility, 10)]);
    const name = (await ctx.prisma.drip.findUniqueOrThrow({ where: { id } })).name;
    const [a] = await enrolled(id, ['Chat A']);
    const chat = await ctx.prisma.conversation.create({ data: { contactId: a!.id, numberId, state: 'ACTIVE', lastCustomerMessageAt: new Date() } });
    await tick();
    const [message] = await dripMessages(id, a!.id);
    mockMetaSends(phoneNumberId, [a!.phoneE164]);
    expect((await ctx.app.get(SendProcessor).process(message!.id, 1)).result).toBe('sent');

    const items = await api(manager, 'get', `/inbox/conversations/${chat.id}/items`);
    const ref = (items.body.items as Array<Record<string, unknown>>).find((i) => i.kind === 'MESSAGE_REF')!;
    expect(ref).toMatchObject({ origin: 'AUTOMATIC', drip: { id, name, step: 1 } });

    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(phoneNumberId, a!.phoneE164.slice(1), 'Thanks!')));
    const journey = (await api(manager, 'get', `/inbox/conversations/${chat.id}/journey`)).body as Array<{ type: string; data: Record<string, unknown> }>;
    expect(journey.find((e) => e.type === 'DRIP_JOINED')?.data).toMatchObject({ dripId: id, dripName: name, via: 'MANUAL' });
    expect(journey.find((e) => e.type === 'DRIP_LEFT')?.data).toMatchObject({ dripId: id, dripName: name, reason: 'REPLIED' });
  });
});
