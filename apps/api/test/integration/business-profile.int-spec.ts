import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { FakeBusinessGraph } from '../support/fake-business-graph.js';
import { jpegHeader, pngHeader } from '../support/images.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T074 (feature 010 US7, FR-031 – FR-033, research R11, R12): the WhatsApp Business profile through Meta, the
// display name status, profile pictures and the blue tick checklist.
describe('Business profile and blue tick checklist (010 US7)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let graph: FakeBusinessGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;

  const put = (who: SignedInAgent, path: string, body: object) => who.agent.put(`/api${path}`).set('X-CSRF-Token', who.csrf).send(body);
  const upload = (who: SignedInAgent, file: Buffer, name: string, type: string) =>
    who.agent.post(`/api/numbers/${number.id}/business-profile/picture`).set('X-CSRF-Token', who.csrf).attach('file', file, { filename: name, contentType: type });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    [admin, manager] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER')]);
    number = await seedNumber(ctx);
    graph = new FakeBusinessGraph().number(number.phoneNumberId, { about: 'Sofas and beds', address: 'Dubai Mall', email: 'hello@acme.test', websites: ['https://acme.test'], vertical: 'RETAIL' }).install();
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  it('combines the profile and the number status, and keeps them 5 minutes', async () => {
    const res = await manager.agent.get(`/api/numbers/${number.id}/business-profile`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      numberId: number.id,
      about: 'Sofas and beds',
      address: 'Dubai Mall',
      websites: ['https://acme.test'],
      vertical: 'RETAIL',
      verifiedName: 'Acme Store',
      nameStatus: 'APPROVED',
      newNameStatus: null,
      qualityRating: 'GREEN',
      messagingLimit: 'TIER_2K',
    });
    expect((await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: number.id } })).messagingLimitTier).toBe('TIER_2K');
    const calls = graph.calls;
    expect((await manager.agent.get(`/api/numbers/${number.id}/business-profile`)).status).toBe(200);
    expect(graph.calls).toBe(calls);
  });

  it('sends only changed fields, returns what Meta holds, and audits field names only', async () => {
    const res = await put(admin, `/numbers/${number.id}/business-profile`, { about: 'Sofas, beds and tables', address: 'Dubai Mall', websites: ['https://acme.test', 'https://shop.acme.test'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(graph.posts.at(-1)).toEqual({ phoneNumberId: number.phoneNumberId, body: { messaging_product: 'whatsapp', about: 'Sofas, beds and tables', websites: ['https://acme.test', 'https://shop.acme.test'] } });
    expect(res.body).toMatchObject({ about: 'Sofas, beds and tables', websites: ['https://acme.test', 'https://shop.acme.test'], changedAt: expect.any(String) });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'business_profile.changed', targetId: number.id }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toEqual({ fields: ['about', 'websites'] });
    expect(JSON.stringify(audit.metadata)).not.toContain('Sofas');
    expect((await put(manager, `/numbers/${number.id}/business-profile`, { about: 'x' })).status).toBe(403);
  });

  it("refuses values beyond Meta's limits before calling Meta, and keeps Meta's message when it refuses", async () => {
    const posts = graph.posts.length;
    const tooLong = await put(admin, `/numbers/${number.id}/business-profile`, { about: 'a'.repeat(140), websites: ['ftp://acme.test', 'https://a.test', 'https://b.test'], vertical: 'SPACE' });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.details).toEqual(
      expect.arrayContaining([
        { field: 'about', issue: 'must be at most 139 characters' },
        { field: 'websites', issue: 'at most 2 websites' },
        { field: 'vertical', issue: "is not one of Meta's categories" },
      ]),
    );
    expect((await put(admin, `/numbers/${number.id}/business-profile`, { email: 'not-an-email' })).body.details).toEqual([{ field: 'email', issue: 'must be a valid email address' }]);
    expect(graph.posts.length).toBe(posts);

    graph.failNextPost = { status: 400, code: 100, message: 'Param description must be at most 512 characters long' };
    const refused = await put(admin, `/numbers/${number.id}/business-profile`, { description: 'A new description' });
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ code: 'META_REFUSED', details: [{ field: 'description', issue: 'Param description must be at most 512 characters long' }] });
  });

  it('makes no Meta call for a number that is not connected', async () => {
    const off = await seedNumber(ctx, { connectionStatus: 'DISCONNECTED' });
    const calls = graph.calls;
    const res = await manager.agent.get(`/api/numbers/${off.id}/business-profile`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NUMBER_NOT_CONNECTED');
    expect((await put(admin, `/numbers/${off.id}/business-profile`, { about: 'Hi' })).body.code).toBe('NUMBER_NOT_CONNECTED');
    expect(graph.calls).toBe(calls);
  });

  it('uploads a square picture through the Resumable Upload flow and refuses the rest', async () => {
    const ok = await upload(admin, pngHeader(640, 640), 'logo.png', 'image/png');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(graph.uploads).toHaveLength(1);
    expect(graph.posts.at(-1)!.body).toMatchObject({ messaging_product: 'whatsapp', profile_picture_handle: expect.stringMatching(/^handle-/) });
    expect(ok.body.profilePictureUrl).toMatch(/^https:\/\/pps\.whatsapp\.test\//);

    const wide = await upload(admin, jpegHeader(3000, 2000), 'banner.jpg', 'image/jpeg');
    expect(wide.status).toBe(422);
    expect(wide.body).toMatchObject({ code: 'PICTURE_RULES', details: [{ field: 'file', issue: 'must be square' }] });
    const big = await upload(admin, pngHeader(1000, 1000, 5 * 1024 * 1024 + 1), 'huge.png', 'image/png');
    expect(big.status).toBe(422);
    expect(big.body.details).toContainEqual({ field: 'file', issue: 'must be 5 MB or smaller' });
    expect((await upload(admin, Buffer.from('GIF89a-not-allowed-here'), 'a.gif', 'image/gif')).body.code).toBe('PICTURE_RULES');
    expect(graph.uploads).toHaveLength(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'business_profile.changed', targetId: number.id, metadata: { equals: { fields: ['profile_picture'] } } } })).toBe(1);
  });

  it('shows a declined display name with the request for a new one', async () => {
    const other = await seedNumber(ctx, { phoneNumberId: digits(15) });
    graph.number(other.phoneNumberId, {}, { name_status: 'DECLINED', new_name_status: 'PENDING_REVIEW' });
    const res = await manager.agent.get(`/api/numbers/${other.id}/business-profile`);
    expect(res.body).toMatchObject({ nameStatus: 'DECLINED', newNameStatus: 'PENDING_REVIEW' });
  });

  it('keeps the blue tick checklist: managers read it, admins change it', async () => {
    const before = await manager.agent.get('/api/oba-checklist');
    expect(before.status).toBe(200);
    expect(before.body.steps.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['policy', 'thirty-days', 'business-verification', 'two-step', 'display-name', 'apply']));
    expect(before.body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await put(manager, '/oba-checklist', { steps: { policy: true } })).status).toBe(403);
    expect((await put(admin, '/oba-checklist', { steps: { 'no-such-step': true } })).status).toBe(422);
    const saved = await put(admin, '/oba-checklist', { steps: { policy: true, 'two-step': true }, appliedAt: '2026-11-20', result: 'PENDING', note: 'Applied with the trade licence' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const policy = saved.body.steps.find((s: { id: string }) => s.id === 'policy');
    expect(policy).toMatchObject({ done: true, at: expect.any(String) });
    expect(saved.body).toMatchObject({ appliedAt: '2026-11-20', result: 'PENDING', note: 'Applied with the trade licence' });
    const undone = await put(admin, '/oba-checklist', { steps: { policy: false } });
    expect(undone.body.steps.find((s: { id: string }) => s.id === 'policy')).toMatchObject({ done: false, at: null });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'oba_checklist.changed' } })).toBeGreaterThanOrEqual(2);
  });
});
