import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { META_BASE, META_VERSION, digits, restoreNetwork, seedRunningCampaign, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T071: connect, validate with Meta, refresh, update and disconnect numbers (FR-001, FR-002).
describe('Numbers API', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  const mockPhoneNumber = (phoneNumberId: string, token: string, fields: Record<string, unknown> = {}) =>
    nock(META_BASE)
      .get(`/${META_VERSION}/${phoneNumberId}`)
      .query(true)
      .matchHeader('authorization', `Bearer ${token}`)
      .reply(200, {
        id: phoneNumberId,
        display_phone_number: '+1 555-010-0001',
        verified_name: 'Acme Store',
        quality_rating: 'GREEN',
        status: 'CONNECTED',
        throughput: { level: 'STANDARD' },
        ...fields,
      });

  const connect = (body: Record<string, unknown>, who: SignedInAgent = admin) =>
    who.agent.post('/api/numbers').set('x-csrf-token', who.csrf).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('connects a number after Meta validates the credentials and never returns the token', async () => {
    const phoneNumberId = digits(15);
    mockPhoneNumber(phoneNumberId, 'good-token');
    const res = await connect({ label: 'Main line', wabaId: 'WABA-1', phoneNumberId, accessToken: 'good-token' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      label: 'Main line',
      wabaId: 'WABA-1',
      phoneNumberId,
      displayPhoneNumber: '+1 555-010-0001',
      verifiedName: 'Acme Store',
      connectionStatus: 'CONNECTED',
      qualityRating: 'GREEN',
      throughputLevel: 'STANDARD',
      sendRatePerSecond: 20,
      sendingEnabled: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('good-token');
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('accessTokenEnc');

    const row = await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { phoneNumberId } });
    expect(row.accessTokenEnc.startsWith('v1:')).toBe(true);
    expect(row.accessTokenEnc).not.toContain('good-token');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'number.connected', targetId: row.id } })).toBe(1);

    const list = await admin.agent.get('/api/numbers');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/good-token|accessToken/);
    const detail = await admin.agent.get(`/api/numbers/${row.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('accessTokenEnc');
  });

  it('rejects credentials Meta refuses with 422 and saves nothing', async () => {
    const phoneNumberId = digits(15);
    nock(META_BASE)
      .get(`/${META_VERSION}/${phoneNumberId}`)
      .query(true)
      .reply(401, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });

    const res = await connect({ label: 'Bad', wabaId: 'WABA-1', phoneNumberId, accessToken: 'bad-token' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('META_ERROR');
    expect(res.body.message).toMatch(/token/i);
    expect(await ctx.prisma.whatsAppNumber.count({ where: { phoneNumberId } })).toBe(0);
  });

  it('refuses a duplicate phone number id with 409 without calling Meta', async () => {
    const phoneNumberId = digits(15);
    mockPhoneNumber(phoneNumberId, 'tok');
    expect((await connect({ label: 'One', wabaId: 'W', phoneNumberId, accessToken: 'tok' })).status).toBe(201);
    const again = await connect({ label: 'Two', wabaId: 'W', phoneNumberId, accessToken: 'tok' });
    expect(again.status).toBe(409);
  });

  it('validates input and enforces numbers.manage', async () => {
    expect((await connect({ label: 'x' })).status).toBe(422);
    const manager = await signIn(ctx, 'MANAGER');
    expect((await connect({ label: 'x', wabaId: 'W', phoneNumberId: '1', accessToken: 't' }, manager)).status).toBe(403);
    expect((await manager.agent.get('/api/numbers')).status).toBe(200);
  });

  it('refreshes status, quality and throughput from Meta', async () => {
    const phoneNumberId = digits(15);
    mockPhoneNumber(phoneNumberId, 'tok');
    const created = await connect({ label: 'Refresh me', wabaId: 'W', phoneNumberId, accessToken: 'tok' });
    mockPhoneNumber(phoneNumberId, 'tok', { quality_rating: 'YELLOW', throughput: { level: 'HIGH' } });

    const res = await admin.agent.post(`/api/numbers/${created.body.id}/refresh`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ qualityRating: 'YELLOW', throughputLevel: 'HIGH', connectionStatus: 'CONNECTED' });
    expect(res.body.lastSyncedAt).toBeTruthy();
  });

  it('updates the send rate and kill switch, and re-validates a new token', async () => {
    const phoneNumberId = digits(15);
    mockPhoneNumber(phoneNumberId, 'tok');
    const created = await connect({ label: 'Edit me', wabaId: 'W', phoneNumberId, accessToken: 'tok' });
    const id = created.body.id as string;

    const patched = await admin.agent
      .patch(`/api/numbers/${id}`)
      .set('x-csrf-token', admin.csrf)
      .send({ sendRatePerSecond: 40, sendingEnabled: false, label: 'Renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ sendRatePerSecond: 40, sendingEnabled: false, label: 'Renamed' });

    const tooFast = await admin.agent.patch(`/api/numbers/${id}`).set('x-csrf-token', admin.csrf).send({ sendRatePerSecond: 0 });
    expect(tooFast.status).toBe(422);

    mockPhoneNumber(phoneNumberId, 'new-token');
    const rotated = await admin.agent.patch(`/api/numbers/${id}`).set('x-csrf-token', admin.csrf).send({ accessToken: 'new-token' });
    expect(rotated.status).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'number.credentials_changed', targetId: id } })).toBe(1);
  });

  it('disconnecting a number pauses its running campaigns', async () => {
    const phoneNumberId = digits(15);
    mockPhoneNumber(phoneNumberId, 'tok');
    const created = await connect({ label: 'Disconnect me', wabaId: 'WD', phoneNumberId, accessToken: 'tok' });
    const template = await seedTemplate(ctx, 'WD');
    const campaign = await seedRunningCampaign(ctx, { numberId: created.body.id, templateId: template.id, createdById: admin.userId, contacts: [] });

    const res = await admin.agent.delete(`/api/numbers/${created.body.id}`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(204);
    const number = await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(number.connectionStatus).toBe('DISCONNECTED');
    const paused = await ctx.prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(paused).toMatchObject({ state: 'PAUSED', pausedReason: 'number_disconnected' });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'number.disconnected', targetId: created.body.id } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.auto_paused', targetId: campaign.id } })).toBe(1);
  });
});
