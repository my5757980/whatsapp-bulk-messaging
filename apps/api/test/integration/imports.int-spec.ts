import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportProcessor } from '../../src/modules/imports/import.processor.js';
import { csvFile, digits, seedContact, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T116: contacts import with column mapping, create-or-update by phone and an error report (FR-010).
describe('Contacts import', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const s = digits(4);
  const keys = { city: `city_${s}`, orders: `orders_${s}`, last: `last_order_${s}` };
  const p = (n: number) => `+9715055${s}${n}`; // valid UAE mobiles, unique per run

  const startImport = (file: Buffer, mapping: unknown, optInSourceNote?: string) => {
    const req = admin.agent
      .post('/api/imports')
      .set('x-csrf-token', admin.csrf)
      .field('mapping', typeof mapping === 'string' ? mapping : JSON.stringify(mapping));
    if (optInSourceNote) req.field('optInSourceNote', optInSourceNote);
    return req.attach('file', file, { filename: 'contacts.csv', contentType: 'text/csv' });
  };
  const contact = (phone: string) =>
    ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone }, include: { tags: { include: { tag: true } }, consentEvents: true } });

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
    await ctx.prisma.attributeDefinition.createMany({
      data: [
        { key: keys.city, label: 'City', type: 'TEXT' },
        { key: keys.orders, label: 'Orders', type: 'NUMBER' },
        { key: keys.last, label: 'Last order', type: 'DATE' },
      ],
    });
  });
  afterAll(async () => ctx.close());

  it('creates and updates contacts by phone with tags, typed attributes and per-row opt-in sources', async () => {
    await seedContact(ctx, p(3), { name: null, consentStatus: 'UNKNOWN', consentSource: null });
    await seedContact(ctx, p(4), { name: 'Dina', consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });

    const file = csvFile([
      'phone,full_name,labels,city,orders,last_order,consent_source',
      `${p(1)},Amal,VIP;newsletter,Dubai,3,2026-01-05,Website form`,
      `0${p(2).slice(4)},Basim,vip,Sharjah,,2025-12-24,`,
      `${p(3)},Carla,,Ajman,10,,Store tablet`,
      `${p(4)},Dina,newsletter,,,,Website form`,
      `${p(1)},Amal again,,,,,`,
      '12345,Bad phone,,,,,',
      `${p(6)},Bad number,,Dubai,many,,`,
      `${p(7)},Bad date,,Dubai,1,31/12/2025,`,
    ]);
    const mapping = { phone: 'phone', name: 'full_name', tags: 'labels', attributes: { [keys.city]: 'city', [keys.orders]: 'orders', [keys.last]: 'last_order' }, optInSource: 'consent_source' };
    const res = await startImport(file, mapping);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'CONTACTS', status: 'QUEUED', columns: ['phone', 'full_name', 'labels', 'city', 'orders', 'last_order', 'consent_source'] });

    await ctx.app.get(ImportProcessor).process(res.body.id);
    const job = await admin.agent.get(`/api/imports/${res.body.id}`);
    expect(job.body).toMatchObject({ status: 'COMPLETED', totalRows: 8, createdCount: 2, updatedCount: 2, skippedCount: 1, errorCount: 3, hasErrorReport: true });

    const amal = await contact(p(1));
    expect(amal).toMatchObject({
      name: 'Amal',
      consentStatus: 'OPTED_IN',
      consentSource: 'IMPORT',
      consentSourceNote: 'Website form',
      attributes: { [keys.city]: 'Dubai', [keys.orders]: 3, [keys.last]: '2026-01-05' },
    });
    expect(amal.tags.map((t) => t.tag.name).sort()).toEqual(['newsletter', 'vip']);
    expect(amal.consentEvents).toEqual([expect.objectContaining({ status: 'OPTED_IN', source: 'IMPORT', note: 'Website form', actorUserId: admin.userId })]);

    const basim = await contact(p(2));
    expect(basim).toMatchObject({ consentStatus: 'UNKNOWN', attributes: { [keys.city]: 'Sharjah', [keys.last]: '2025-12-24' } });
    expect(basim.attributes).not.toHaveProperty(keys.orders);

    expect(await contact(p(3))).toMatchObject({ name: 'Carla', consentStatus: 'OPTED_IN', consentSourceNote: 'Store tablet', attributes: { [keys.city]: 'Ajman', [keys.orders]: 10 } });

    // An import never re-opts-in a contact who opted out (constitution Principle I).
    const dina = await contact(p(4));
    expect(dina.consentStatus).toBe('OPTED_OUT');
    expect(dina.consentEvents).toHaveLength(0);
    expect(dina.tags.map((t) => t.tag.name)).toEqual(['newsletter']);

    const report = await admin.agent.get(`/api/imports/${res.body.id}/errors`);
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toMatch(/text\/csv/);
    const lines = report.text.trim().split('\n');
    expect(lines[0]).toBe('row,phone,reason');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['6', '7', '8']);
    expect(report.text).toMatch(/valid phone number/i);
    expect(report.text).toContain(`${keys.orders}: must be a number`);
    expect(report.text).toMatch(/YYYY-MM-DD/);
  });

  it('confirms a whole file as opted in with a source note', async () => {
    const res = await startImport(csvFile(['phone,full_name', `${p(2)},Basim`]), { phone: 'phone', name: 'full_name' }, 'Event sign-up sheet, Nov 2026');
    await ctx.app.get(ImportProcessor).process(res.body.id);
    expect((await admin.agent.get(`/api/imports/${res.body.id}`)).body).toMatchObject({ createdCount: 0, updatedCount: 1, errorCount: 0, hasErrorReport: false });
    expect(await contact(p(2))).toMatchObject({ consentStatus: 'OPTED_IN', consentSource: 'IMPORT', consentSourceNote: 'Event sign-up sheet, Nov 2026' });
    expect((await admin.agent.get(`/api/imports/${res.body.id}/errors`)).status).toBe(404);
  });

  it('keeps a failed attempt queued for its retry and fails only on the last attempt', async () => {
    const job = await ctx.prisma.importJob.create({
      data: { kind: 'CONTACTS', fileKey: `uploads/imports/missing-${s}-${Date.now()}.csv`, mapping: { phone: 'phone', delimiter: ',' }, createdById: admin.userId },
    });
    const processor = ctx.app.get(ImportProcessor);
    await expect(processor.process(job.id, false)).rejects.toThrow();
    expect(await ctx.prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'QUEUED',
      finishedAt: null,
      error: expect.stringMatching(/^Attempt failed, retrying: /),
    });
    await expect(processor.process(job.id, true)).rejects.toThrow();
    expect((await ctx.prisma.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('rejects malformed uploads with 422', async () => {
    const ok = csvFile(['phone,name', `${p(8)},X`]);
    expect((await startImport(ok, '{not json')).status).toBe(422);
    expect((await startImport(ok, { name: 'name' })).status).toBe(422);
    expect((await startImport(ok, { phone: 'mobile' })).status).toBe(422);
    expect((await startImport(ok, { phone: 'phone', attributes: { undefined_key: 'name' } })).status).toBe(422);
    expect((await startImport(Buffer.from(''), { phone: 'phone' })).status).toBe(422);
    const noFile = await admin.agent.post('/api/imports').set('x-csrf-token', admin.csrf).field('mapping', JSON.stringify({ phone: 'phone' }));
    expect(noFile.status).toBe(422);
  });
});
