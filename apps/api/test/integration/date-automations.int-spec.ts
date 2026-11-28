import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateAutomationTickProcessor } from '../../src/modules/automations/date-automation-tick.processor.js';
import { addDays, companyClock, dayDate } from '../../src/modules/automations/due-query.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, mockMetaSends, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T056 (feature 010 US5, FR-020 – FR-024, research R9): date automations, the minute tick with a fake clock,
// skips, pausing, results and recipients.
describe('Date automations (010 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let utilityId: string;
  let marketingId: string;
  let timeZone: string;
  const suffix = digits(6);
  const key = (name: string) => `${name}_${suffix}`;

  const send = (who: SignedInAgent, method: 'post' | 'put' | 'delete', path: string, body?: object) => who.agent[method](`/api${path}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const tick = (now: Date) => ctx.app.get(DateAutomationTickProcessor).tick(now);
  /** An instant whose company day is `day`. */
  const instantOn = (day: string): Date => {
    for (const hour of ['12', '00', '23', '06', '18']) {
      const at = new Date(`${day}T${hour}:00:00Z`);
      if (companyClock(at, timeZone).date === day) return at;
    }
    throw new Error(`no instant on ${day}`);
  };
  const attribute = (name: string, type: 'DATE' | 'TEXT' = 'DATE') => ctx.prisma.attributeDefinition.create({ data: { key: key(name), label: name, type } });
  const automation = async (body: Record<string, unknown>) => {
    const res = await send(manager, 'post', '/date-automations', {
      timing: 'YEARLY',
      offsetDays: 0,
      sendTime: '00:00',
      numberId: number.id,
      templateId: utilityId,
      variableMapping: { 'BODY.1': { source: 'field', key: 'name', fallback: 'friend' } },
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string; status: string };
  };
  const switchOn = async (id: string, on = true) => {
    const res = await send(manager, 'post', `/date-automations/${id}/switch`, { on });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const occurrences = (automationId: string) =>
    ctx.prisma.dateAutomationOccurrence.findMany({ where: { automationId }, include: { message: true, contact: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
  const contactWith = (attrKey: string, date: string | null, extra: Record<string, unknown> = {}) =>
    seedContact(ctx, uaePhone(), { name: `Dated ${digits(4)}`, attributes: date ? { [attrKey]: date } : {}, ...extra });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    [admin, manager, agent] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER'), signIn(ctx, 'AGENT')]);
    number = await seedNumber(ctx);
    utilityId = (await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' })).id;
    marketingId = (await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' })).id;
    timeZone = ((await admin.agent.get('/api/settings')).body as { defaultTimezone: string }).defaultTimezone;
  });

  afterAll(async () => {
    await ctx.prisma.dateAutomation.updateMany({ where: { name: { endsWith: suffix } }, data: { status: 'OFF' } });
    restoreNetwork();
    await ctx.close();
  });

  it('creates, previews, switches and deletes automations with their checks', async () => {
    const birthday = await attribute('birthday');
    const city = await attribute('city', 'TEXT');
    const today = companyClock(new Date(), timeZone).date;

    const notDate = await send(manager, 'post', '/date-automations', { name: `Wrong ${suffix}`, attributeKey: city.key, timing: 'YEARLY', offsetDays: 0, sendTime: '09:00', numberId: number.id, templateId: utilityId, variableMapping: { 'BODY.1': { source: 'static', value: 'x' } } });
    expect(notDate.status).toBe(422);
    expect(notDate.body.code).toBe('ATTRIBUTE_NOT_DATE');
    const unmapped = await send(manager, 'post', '/date-automations', { name: `Unmapped ${suffix}`, attributeKey: birthday.key, timing: 'YEARLY', offsetDays: 0, sendTime: '09:00', numberId: number.id, templateId: utilityId, variableMapping: {} });
    expect(unmapped.status).toBe(422);
    expect(unmapped.body).toMatchObject({ code: 'VARIABLES_UNMAPPED', details: [{ field: 'variableMapping.BODY.1', issue: 'needs a value' }] });
    expect((await send(agent, 'post', '/date-automations', { name: 'x' })).status).toBe(403);

    const created = await automation({ name: `Birthdays ${suffix}`, attributeKey: birthday.key, sendTime: '09:00' });
    expect(created).toMatchObject({ status: 'OFF', attributeKey: birthday.key, numberLabel: number.label, last7Days: { sent: 0, failed: 0, skipped: 0 } });
    const taken = await send(manager, 'post', '/date-automations', { name: `Birthdays ${suffix}`, attributeKey: birthday.key, timing: 'YEARLY', offsetDays: 0, sendTime: '09:00', numberId: number.id, templateId: utilityId, variableMapping: { 'BODY.1': { source: 'static', value: 'x' } } });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NAME_TAKEN');
    expect((await agent.agent.get('/api/date-automations')).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));

    // The 7-day preview counts contacts due on each day.
    await contactWith(birthday.key, `1990-${today.slice(5)}`);
    await contactWith(birthday.key, `1985-${addDays(today, 1).slice(5)}`);
    await contactWith(birthday.key, `1999-${addDays(today, 1).slice(5)}`);
    const preview = await send(manager, 'post', '/date-automations/preview', { attributeKey: birthday.key, timing: 'YEARLY', offsetDays: 0 });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.days.slice(0, 2)).toEqual([
      { date: today, due: 1 },
      { date: addDays(today, 1), due: 2 },
    ]);
    expect((await send(manager, 'post', '/date-automations/preview', { attributeKey: city.key, timing: 'YEARLY', offsetDays: 0 })).body.code).toBe('ATTRIBUTE_NOT_DATE');

    const edited = await send(manager, 'put', `/date-automations/${created.id}`, { name: `Birthdays ${suffix}`, attributeKey: birthday.key, timing: 'YEARLY', offsetDays: -1, sendTime: '10:30', numberId: number.id, templateId: utilityId, variableMapping: { 'BODY.1': { source: 'static', value: 'friend' } } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ offsetDays: -1, sendTime: '10:30', status: 'OFF' });

    // Switching on needs an approved template.
    const pendingTemplate = await seedTemplate(ctx, number.wabaId, { status: 'PENDING' });
    const waiting = await automation({ name: `Waiting ${suffix}`, attributeKey: birthday.key, templateId: pendingTemplate.id });
    const refused = await send(manager, 'post', `/date-automations/${waiting.id}/switch`, { on: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TEMPLATE_NOT_APPROVED');
    expect((await send(agent, 'post', `/date-automations/${created.id}/switch`, { on: true })).status).toBe(403);
    await switchOn(created.id);
    await switchOn(created.id, false);

    expect((await send(manager, 'delete', `/date-automations/${waiting.id}`)).status).toBe(204);
    expect((await manager.agent.get(`/api/date-automations/${waiting.id}`)).status).toBe(404);
    const actions = (await ctx.prisma.auditLog.findMany({ where: { targetId: { in: [created.id, waiting.id] } }, select: { action: true } })).map((a) => a.action).sort();
    expect(actions).toEqual(['date_automation.created', 'date_automation.created', 'date_automation.deleted', 'date_automation.switched', 'date_automation.switched', 'date_automation.updated']);
  });

  it('sends once to contacts due today and skips the rest with reasons', async () => {
    const day = await attribute('anniversary');
    const nick = await attribute('nick', 'TEXT');
    const now = new Date();
    const today = companyClock(now, timeZone).date;
    const thisDay = `2001-${today.slice(5)}`;
    const due = await contactWith(day.key, thisDay, { consentStatus: 'OPTED_IN', attributes: { [day.key]: thisDay, [nick.key]: 'Sam' } });
    const tomorrow = await contactWith(day.key, `2001-${addDays(today, 1).slice(5)}`, { attributes: { [day.key]: `2001-${addDays(today, 1).slice(5)}`, [nick.key]: 'Tom' } });
    const optedOut = await contactWith(day.key, thisDay, { consentStatus: 'OPTED_OUT', attributes: { [day.key]: thisDay, [nick.key]: 'Out' } });
    const blocked = await contactWith(day.key, thisDay, { blockedAt: new Date(), attributes: { [day.key]: thisDay, [nick.key]: 'Blocked' } });
    const noNick = await contactWith(day.key, thisDay);
    const a = await automation({ name: `Anniversary ${suffix}`, attributeKey: day.key, variableMapping: { 'BODY.1': { source: 'attribute', key: nick.key } } });
    await switchOn(a.id);
    // A contact recorded as due whose date is gone by the time it is sent.
    const undated = await contactWith(day.key, null);
    await ctx.prisma.dateAutomationOccurrence.create({ data: { automationId: a.id, contactId: undated.id, dueDate: dayDate(today) } });

    await tick(now);
    const rows = await occurrences(a.id);
    const byContact = new Map(rows.map((o) => [o.contactId, o]));
    expect(byContact.get(due.id)).toMatchObject({ status: 'PENDING', message: { origin: 'DATE_AUTOMATION', status: 'QUEUED', templateId: utilityId, resolvedParams: { 'BODY.1': 'Sam' } } });
    expect(byContact.get(optedOut.id)).toMatchObject({ status: 'SKIPPED', reason: 'opted_out', messageId: null });
    expect(byContact.get(blocked.id)).toMatchObject({ status: 'SKIPPED', reason: 'blocked' });
    expect(byContact.get(noNick.id)).toMatchObject({ status: 'SKIPPED', reason: 'missing_value' });
    expect(byContact.get(undated.id)).toMatchObject({ status: 'SKIPPED', reason: 'no_date' });
    expect(byContact.has(tomorrow.id)).toBe(false);

    // A second tick sends nothing more.
    await tick(new Date(now.getTime() + 60_000));
    expect(await ctx.prisma.message.count({ where: { origin: 'DATE_AUTOMATION', contactId: due.id } })).toBe(1);

    // The send outcome reaches the occurrence.
    mockMetaSends(number.phoneNumberId, [due.phoneE164]);
    await ctx.app.get(SendProcessor).process(byContact.get(due.id)!.messageId!, 1);
    expect(await ctx.prisma.dateAutomationOccurrence.findUniqueOrThrow({ where: { id: byContact.get(due.id)!.id } })).toMatchObject({ status: 'SENT' });

    // Tomorrow, today's leftovers never go out, and tomorrow's contact is due.
    const leftover = await contactWith(day.key, thisDay, { attributes: { [day.key]: thisDay, [nick.key]: 'Late' } });
    await ctx.prisma.dateAutomationOccurrence.create({ data: { automationId: a.id, contactId: leftover.id, dueDate: dayDate(today) } });
    await tick(instantOn(addDays(today, 1)));
    expect(await ctx.prisma.dateAutomationOccurrence.findFirstOrThrow({ where: { automationId: a.id, contactId: leftover.id } })).toMatchObject({ status: 'SKIPPED', reason: 'too_late', messageId: null });
    expect((await occurrences(a.id)).find((o) => o.contactId === tomorrow.id)).toMatchObject({ dueDate: dayDate(addDays(today, 1)), message: { resolvedParams: { 'BODY.1': 'Tom' } } });
    await switchOn(a.id, false);
  });

  it('handles offsets, one-time dates, marketing consent and global attributes', async () => {
    const renewal = await attribute('renewal');
    const now = new Date();
    const today = companyClock(now, timeZone).date;
    await ctx.prisma.globalAttribute.create({ data: { key: key('shop'), value: 'Acme Sofas' } });
    // Three days before a one-time renewal date.
    const soon = await contactWith(renewal.key, addDays(today, 3), { consentStatus: 'OPTED_IN' });
    const lastYear = await contactWith(renewal.key, addDays(addDays(today, 3), -365));
    const once = await automation({ name: `Renewal ${suffix}`, attributeKey: renewal.key, timing: 'ONCE', offsetDays: -3, variableMapping: { 'BODY.1': { source: 'global', key: key('shop') } } });
    // A marketing template reaches only opted-in contacts.
    const promo = await automation({ name: `Renewal promo ${suffix}`, attributeKey: renewal.key, timing: 'ONCE', offsetDays: -3, templateId: marketingId });
    const unknown = await contactWith(renewal.key, addDays(today, 3), { consentStatus: 'UNKNOWN' });
    await switchOn(once.id);
    await switchOn(promo.id);

    await tick(now);
    const onceRows = await occurrences(once.id);
    expect(onceRows.find((o) => o.contactId === soon.id)).toMatchObject({ message: { resolvedParams: { 'BODY.1': 'Acme Sofas' } } });
    expect(onceRows.some((o) => o.contactId === lastYear.id)).toBe(false);
    const promoRows = await occurrences(promo.id);
    expect(promoRows.find((o) => o.contactId === unknown.id)).toMatchObject({ status: 'SKIPPED', reason: 'not_opted_in' });
    expect(promoRows.find((o) => o.contactId === soon.id)?.message?.templateId).toBe(marketingId);
    await switchOn(once.id, false);
    await switchOn(promo.id, false);
  });

  it('pauses with one admin notification when the template or number fails, and resuming never sends past days', async () => {
    const day = await attribute('joined');
    const now = new Date();
    const today = companyClock(now, timeZone).date;
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const a = await automation({ name: `Joined ${suffix}`, attributeKey: day.key, templateId: template.id });
    await switchOn(a.id);
    await ctx.prisma.template.update({ where: { id: template.id }, data: { status: 'REJECTED' } });
    const admins = await ctx.prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });

    await tick(now);
    await tick(new Date(now.getTime() + 60_000));
    expect(await ctx.prisma.dateAutomation.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'PAUSED', pausedReason: 'TEMPLATE_NOT_APPROVED' });
    expect(await ctx.prisma.notification.count({ where: { type: 'DATE_AUTOMATION_PAUSED', link: `/automations/${a.id}` } })).toBe(admins);

    // While paused, yesterday's due contact was never sent; resuming today does not send it.
    const yesterday = await contactWith(day.key, `1995-${addDays(today, -1).slice(5)}`);
    await ctx.prisma.dateAutomationOccurrence.create({ data: { automationId: a.id, contactId: yesterday.id, dueDate: dayDate(addDays(today, -1)) } });
    const todays = await contactWith(day.key, `1995-${today.slice(5)}`);
    await ctx.prisma.template.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
    await switchOn(a.id);
    await tick(now);
    const rows = await occurrences(a.id);
    expect(rows.find((o) => o.contactId === yesterday.id)).toMatchObject({ status: 'SKIPPED', reason: 'too_late', messageId: null });
    expect(rows.find((o) => o.contactId === todays.id)?.message?.status).toBe('QUEUED');

    // A disconnected number pauses it too.
    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { connectionStatus: 'DISCONNECTED' } });
    await tick(now);
    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { connectionStatus: 'CONNECTED' } });
    expect(await ctx.prisma.dateAutomation.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'PAUSED', pausedReason: 'NUMBER_DISCONNECTED' });
  });

  it('reports results per day with the 009 replied definition, and the recipients of a day', async () => {
    const day = await attribute('visit');
    const now = new Date();
    const today = companyClock(now, timeZone).date;
    const replier = await contactWith(day.key, `2010-${today.slice(5)}`, { consentStatus: 'OPTED_IN' });
    const silent = await contactWith(day.key, `2011-${today.slice(5)}`);
    await contactWith(day.key, `2012-${today.slice(5)}`, { consentStatus: 'OPTED_OUT' });
    const a = await automation({ name: `Visits ${suffix}`, attributeKey: day.key });
    await switchOn(a.id);
    await tick(now);
    const rows = await occurrences(a.id);
    const sentRow = rows.find((o) => o.contactId === replier.id)!;
    await ctx.prisma.message.update({ where: { id: sentRow.messageId! }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 60_000) } });
    await ctx.prisma.dateAutomationOccurrence.update({ where: { id: sentRow.id }, data: { status: 'SENT' } });
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, replier.phoneE164.slice(1), 'Thank you!')));
    const silentRow = rows.find((o) => o.contactId === silent.id)!;
    await ctx.prisma.message.update({ where: { id: silentRow.messageId! }, data: { status: 'FAILED' } });
    await ctx.prisma.dateAutomationOccurrence.update({ where: { id: silentRow.id }, data: { status: 'FAILED', reason: 'send_failed' } });

    const results = await manager.agent.get(`/api/date-automations/${a.id}/results`).query({ from: today, to: today });
    expect(results.status, JSON.stringify(results.body)).toBe(200);
    expect(results.body.days).toEqual([{ date: today, due: 3, sent: 1, delivered: 1, read: 0, replied: 1, failed: 1, skipped: { opted_out: 1 } }]);
    expect((await manager.agent.get(`/api/date-automations/${a.id}/results`).query({ from: today, to: addDays(today, -1) })).body.code).toBe('RANGE_INVALID');

    const recipients = await agent.agent.get(`/api/date-automations/${a.id}/recipients`).query({ date: today });
    expect(recipients.status).toBe(200);
    expect(recipients.body.total).toBe(3);
    const item = (recipients.body.items as Array<{ contactId: string; phone: string; status: string; messageStatus: string | null }>).find((i) => i.contactId === replier.id);
    expect(item).toMatchObject({ status: 'SENT', messageStatus: 'DELIVERED', phone: `•••• ${replier.phoneE164.slice(-4)}` });
    expect((await admin.agent.get(`/api/date-automations/${a.id}/recipients`).query({ date: today })).body.items.find((i: { contactId: string }) => i.contactId === replier.id).phone).toBe(replier.phoneE164);
    const list = (await manager.agent.get('/api/date-automations')).body.items.find((i: { id: string }) => i.id === a.id);
    expect(list.last7Days).toEqual({ sent: 1, failed: 1, skipped: 1 });
    await switchOn(a.id, false);
  });

  it('sends 29 February dates on 28 February in years without it', async () => {
    const leap = await attribute('leapday');
    const feb29 = await contactWith(leap.key, '2024-02-29');
    const a = await automation({ name: `Leap ${suffix}`, attributeKey: leap.key });
    await switchOn(a.id);
    await tick(instantOn('2027-02-27'));
    expect(await occurrences(a.id)).toEqual([]);
    await tick(instantOn('2027-02-28'));
    expect((await occurrences(a.id)).map((o) => [o.contactId, o.dueDate])).toEqual([[feb29.id, dayDate('2027-02-28')]]);
    await switchOn(a.id, false);
  });
});
