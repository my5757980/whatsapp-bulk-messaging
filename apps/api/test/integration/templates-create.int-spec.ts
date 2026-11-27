import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { META_BASE, META_VERSION, NUMBER_TOKEN, digits, restoreNetwork, seedNumber, seedRunningCampaign, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T133: create, submit, duplicate and delete templates (FR-017, FR-018).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Template authoring', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let wabaId: string;
  let numberId: string;
  let created: { id: string; name: string };

  const create = (body: unknown, who: SignedInAgent = admin) => who.agent.post('/api/templates').set('x-csrf-token', who.csrf).send(body as object);
  const draft = (overrides: Record<string, unknown> = {}) => ({
    wabaId,
    name: `promo_${digits(6)}`,
    language: 'en_US',
    category: 'MARKETING',
    body: { text: 'Hi {{1}}, our sale starts today!', examples: ['Sara'] },
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}', urlExample: 'summer' }],
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    const number = await seedNumber(ctx);
    wabaId = number.wabaId;
    numberId = number.id;
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('rejects invalid templates with field-level details before calling Meta', async () => {
    const res = await create(draft({ name: 'Bad Name', body: { text: 'Hi {{1}} and {{3}}', examples: [] } }));
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'body.text']));
    expect((await create({ name: 'only_a_name' })).status).toBe(422);
    expect((await create(draft({ wabaId: 'UNKNOWN_WABA' }))).status).toBe(422);
  });

  it('submits a valid template to Meta and stores it as pending', async () => {
    const body = draft();
    const scope = nock(META_BASE)
      .post(`/${META_VERSION}/${wabaId}/message_templates`, {
        name: body.name,
        language: 'en_US',
        category: 'MARKETING',
        parameter_format: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Hi {{1}}, our sale starts today!', example: { body_text: [['Sara']] } },
          { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}', example: ['https://shop.example.com/summer'] }] },
        ],
      })
      .matchHeader('authorization', `Bearer ${NUMBER_TOKEN}`)
      .reply(200, { id: 'mt-created-1', status: 'PENDING', category: 'MARKETING' });

    const res = await create(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: body.name,
      wabaId,
      status: 'PENDING',
      category: 'MARKETING',
      metaTemplateId: 'mt-created-1',
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BUTTON.0.1', example: 'https://shop.example.com/summer' },
      ],
    });
    expect(scope.isDone()).toBe(true);
    created = res.body;

    expect((await create(draft({ name: body.name }))).status).toBe(409);
  });

  it('turns Meta rejections into readable errors', async () => {
    nock(META_BASE)
      .post(`/${META_VERSION}/${wabaId}/message_templates`)
      .reply(400, {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2388042, error_user_msg: 'Message template language is being deleted', fbtrace_id: 'T' },
      });
    const res = await create(draft());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('META_ERROR');
    expect(res.body.message).toMatch(/being deleted/);
  });

  it('uploads header media with the resumable upload API and sends the handle', async () => {
    const media = await admin.agent
      .post('/api/media')
      .set('x-csrf-token', admin.csrf)
      .field('purpose', 'TEMPLATE_SAMPLE')
      .attach('file', PNG, { filename: 'header.png', contentType: 'image/png' });
    expect(media.status).toBe(201);
    const appId = process.env.META_APP_ID as string;

    const scope = nock(META_BASE)
      .post(`/${META_VERSION}/${appId}/uploads`)
      .query((q) => q.file_length === String(PNG.length) && q.file_type === 'image/png' && Boolean(q.file_name))
      .reply(200, { id: 'upload:SESSION123' })
      .post(`/${META_VERSION}/upload:SESSION123`)
      .matchHeader('file_offset', '0')
      .matchHeader('authorization', `OAuth ${NUMBER_TOKEN}`)
      .reply(200, { h: '4::aGVhZGVy' })
      .post(`/${META_VERSION}/${wabaId}/message_templates`, (b: { components: Array<{ type: string; format?: string; example?: { header_handle?: string[] } }> }) => {
        const header = b.components[0];
        return header?.type === 'HEADER' && header.format === 'IMAGE' && header.example?.header_handle?.[0] === '4::aGVhZGVy';
      })
      .reply(200, { id: 'mt-media-1', status: 'PENDING', category: 'UTILITY' });

    const res = await create(draft({ category: 'UTILITY', header: { format: 'IMAGE', mediaAssetId: media.body.id }, buttons: [] }));
    expect(res.status).toBe(201);
    expect(scope.isDone()).toBe(true);
    const stored = await ctx.prisma.template.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.headerMediaAssetId).toBe(media.body.id);
    expect((await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.body.id } })).metaHeaderHandle).toBe('4::aGVhZGVy');
  });

  it('duplicates a template into an editable draft', async () => {
    const res = await admin.agent.post(`/api/templates/${created.id}/duplicate`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      wabaId,
      name: `${created.name}_copy`,
      language: 'en_US',
      category: 'MARKETING',
      header: null,
      body: { text: 'Hi {{1}}, our sale starts today!', examples: ['Sara'] },
      footer: 'Reply STOP to unsubscribe',
      buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}', urlExample: 'https://shop.example.com/summer' }],
      // Feature 009: the kind and the time-to-live come with the copy.
      kind: 'STANDARD',
      ttlSeconds: null,
    });
  });

  it('deletes unused templates locally and in Meta, but not ones a campaign uses', async () => {
    const inUse = await seedTemplate(ctx, wabaId);
    await seedRunningCampaign(ctx, { numberId, templateId: inUse.id, createdById: admin.userId, contacts: [] });
    const blocked = await admin.agent.delete(`/api/templates/${inUse.id}`).set('x-csrf-token', admin.csrf);
    expect(blocked.status).toBe(409);

    const scope = nock(META_BASE)
      .delete(`/${META_VERSION}/${wabaId}/message_templates`)
      .query({ name: created.name, hsm_id: 'mt-created-1' })
      .reply(200, { success: true });
    const res = await admin.agent.delete(`/api/templates/${created.id}`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(204);
    expect(scope.isDone()).toBe(true);
    expect((await ctx.prisma.template.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('DELETED');
  });

  it('limits authoring to templates.manage', async () => {
    const agent = await signIn(ctx, 'AGENT');
    expect((await create(draft(), agent)).status).toBe(403);
    expect((await agent.agent.delete(`/api/templates/${created.id}`).set('x-csrf-token', agent.csrf)).status).toBe(403);
  });
});
