import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AudienceUploadProcessor } from '../../src/modules/campaigns/audience-upload.processor.js';
import { csvFile, seedContact, seedNumber, seedTemplate, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T073: campaign audience upload with mandatory opt-in confirmation (FR-019, FR-012).
describe('Campaign audience upload', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let campaignId: string;

  const upload = (fields: Record<string, string>, file = csvFile(['phone', '+971501110001'])) => {
    const req = admin.agent.post(`/api/campaigns/${campaignId}/audience-upload`).set('x-csrf-token', admin.csrf);
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach('file', file, { filename: 'audience.csv', contentType: 'text/csv' });
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const draft = await admin.agent
      .post('/api/campaigns')
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Upload test', numberId: number.id, templateId: template.id, audienceType: 'UPLOAD' });
    expect(draft.status).toBe(201);
    expect(draft.body.state).toBe('DRAFT');
    campaignId = draft.body.id;
  });
  afterAll(async () => ctx.close());

  it('requires opt-in confirmation, a source note and a known phone column', async () => {
    const base = { phoneColumn: 'phone', optInSourceNote: 'Signed up at the store' };
    expect((await upload({ ...base })).status).toBe(422);
    expect((await upload({ ...base, optInConfirmed: 'false' })).status).toBe(422);
    expect((await upload({ phoneColumn: 'phone', optInConfirmed: 'true' })).status).toBe(422);
    const wrongColumn = await upload({ ...base, phoneColumn: 'mobile', optInConfirmed: 'true' });
    expect(wrongColumn.status).toBe(422);
    expect(JSON.stringify(wrongColumn.body)).toContain('mobile');
  });

  it('stores valid rows, upserts contacts with confirmed opt-in and counts skipped rows', async () => {
    await seedContact(ctx, '+971501110003', { consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD', name: 'Lina' });
    await seedContact(ctx, '+971501110004', { consentStatus: 'UNKNOWN', consentSource: null, name: null });

    const res = await upload(
      { phoneColumn: 'phone', nameColumn: 'name', optInConfirmed: 'true', optInSourceNote: 'Website checkout opt-in' },
      csvFile([
        'name,phone,city',
        'Sara,+971501110001,Dubai',
        'Omar,0501110002,Sharjah',
        'Lina,+971501110003,Ajman',
        'Huda,+971 50 111 0004,Fujairah',
        'Sara again,+971 50 111 0001,Dubai',
        'Bad,12345,Nowhere',
      ]),
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'CAMPAIGN_AUDIENCE', status: 'QUEUED', columns: ['name', 'phone', 'city'] });

    await ctx.app.get(AudienceUploadProcessor).process(res.body.id);

    const job = await admin.agent.get(`/api/imports/${res.body.id}`);
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({
      status: 'COMPLETED',
      totalRows: 6,
      createdCount: 2, // Sara, Omar
      updatedCount: 1, // Huda (opt-in confirmed)
      skippedCount: 2, // duplicate Sara + opted-out Lina
      errorCount: 1, // invalid number
      columns: ['name', 'phone', 'city'],
    });
    expect(job.body.finishedAt).toBeTruthy();

    const rows = await ctx.prisma.campaignUploadRow.findMany({ where: { campaignId }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => r.phoneE164)).toEqual(['+971501110001', '+971501110002', '+971501110003', '+971501110004']);
    expect(rows[0]?.data).toMatchObject({ name: 'Sara', city: 'Dubai' });

    const sara = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: '+971501110001' }, include: { consentEvents: true } });
    expect(sara).toMatchObject({ name: 'Sara', consentStatus: 'OPTED_IN', consentSource: 'UPLOAD_CONFIRMATION', consentSourceNote: 'Website checkout opt-in' });
    expect(sara.consentEvents).toEqual([expect.objectContaining({ status: 'OPTED_IN', source: 'UPLOAD_CONFIRMATION', note: 'Website checkout opt-in', actorUserId: admin.userId })]);

    const huda = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: '+971501110004' } });
    expect(huda).toMatchObject({ consentStatus: 'OPTED_IN', name: 'Huda' });

    // An opt-out always wins over an upload confirmation (constitution Principle I).
    const lina = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: '+971501110003' }, include: { consentEvents: true } });
    expect(lina.consentStatus).toBe('OPTED_OUT');
    expect(lina.consentEvents).toHaveLength(0);
  });

  it('replaces the previous upload and refuses uploads for non-draft campaigns', async () => {
    const res = await upload(
      { phoneColumn: 'phone', optInConfirmed: 'true', optInSourceNote: 'Second list' },
      csvFile(['phone;first_name', '+971501110009;Zara']),
    );
    expect(res.status).toBe(202);
    expect(res.body.columns).toEqual(['phone', 'first_name']);
    await ctx.app.get(AudienceUploadProcessor).process(res.body.id);
    expect(await ctx.prisma.campaignUploadRow.count({ where: { campaignId } })).toBe(1);

    await ctx.prisma.campaign.update({ where: { id: campaignId }, data: { state: 'RUNNING' } });
    const blocked = await upload({ phoneColumn: 'phone', optInConfirmed: 'true', optInSourceNote: 'Store sign-up form' });
    expect(blocked.status).toBe(409);
  });
});
