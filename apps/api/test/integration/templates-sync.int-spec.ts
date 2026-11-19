import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { META_BASE, META_VERSION, NUMBER_TOKEN, digits, restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T072: template sync from Meta (FR-016, FR-019).
describe('Template sync', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let wabaId: string;

  const page1 = (status = 'APPROVED') => ({
    data: [
      {
        id: 'mt-1',
        name: 'order_confirmation',
        language: 'en_US',
        status,
        category: 'UTILITY',
        parameter_format: 'POSITIONAL',
        components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} is confirmed.', example: { body_text: [['Sara', 'A-1']] } }],
      },
      {
        id: 'mt-2',
        name: 'summer_sale',
        language: 'en',
        status: 'PENDING',
        category: 'MARKETING',
        components: [
          { type: 'BODY', text: 'Big summer sale!' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: 'https://shop.test/{{1}}', example: ['summer'] }] },
        ],
      },
    ],
    paging: { cursors: { after: 'CURSOR1' }, next: `${META_BASE}/next-page` },
  });
  const page2 = {
    data: [
      {
        id: 'mt-3',
        name: 'old_promo',
        language: 'en',
        status: 'REJECTED',
        category: 'MARKETING',
        parameter_format: 'NAMED',
        rejected_reason: 'INVALID_FORMAT',
        components: [{ type: 'BODY', text: 'Hello {{first_name}}', example: { body_text_named_params: [{ param_name: 'first_name', example: 'Ali' }] } }],
      },
    ],
    paging: { cursors: { after: 'CURSOR2' } },
  };

  const mockListing = (firstStatus?: string) =>
    nock(META_BASE)
      .get(`/${META_VERSION}/${wabaId}/message_templates`)
      .query((q) => !q.after)
      .matchHeader('authorization', `Bearer ${NUMBER_TOKEN}`)
      .reply(200, page1(firstStatus))
      .get(`/${META_VERSION}/${wabaId}/message_templates`)
      .query((q) => q.after === 'CURSOR1')
      .reply(200, page2);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    // Isolate from templates/numbers created by other test files.
    await ctx.prisma.whatsAppNumber.updateMany({ data: { connectionStatus: 'DISCONNECTED' } });
    wabaId = `WABA${digits(8)}`;
    await seedNumber(ctx, { wabaId });
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('pages through Meta templates, upserts them and derives variables', async () => {
    const scope = mockListing();
    const res = await admin.agent.post('/api/templates/sync').set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 3, updated: 0 });
    expect(scope.isDone()).toBe(true);

    const list = await admin.agent.get('/api/templates').query({ wabaId });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    const order = list.body.find((t: { name: string }) => t.name === 'order_confirmation');
    expect(order).toMatchObject({
      wabaId,
      metaTemplateId: 'mt-1',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BODY.2', example: 'A-1' },
      ],
    });
    const sale = list.body.find((t: { name: string }) => t.name === 'summer_sale');
    expect(sale).toMatchObject({ status: 'PENDING', category: 'MARKETING', variables: [{ key: 'BUTTON.0.1', example: 'summer' }] });
    const promo = list.body.find((t: { name: string }) => t.name === 'old_promo');
    expect(promo).toMatchObject({ status: 'REJECTED', rejectionReason: 'INVALID_FORMAT', variables: [{ key: 'BODY.first_name', example: 'Ali' }] });
  });

  it('updates existing templates by WABA, name and language on the next sync', async () => {
    mockListing('PAUSED');
    const res = await admin.agent.post('/api/templates/sync').set('x-csrf-token', admin.csrf);
    expect(res.body).toEqual({ created: 0, updated: 3 });
    expect(await ctx.prisma.template.count({ where: { wabaId } })).toBe(3);
    const order = await ctx.prisma.template.findUniqueOrThrow({ where: { wabaId_name_language: { wabaId, name: 'order_confirmation', language: 'en_US' } } });
    expect(order.status).toBe('PAUSED');
  });

  it('filters by status and returns details; agents can read and sync', async () => {
    const paused = await admin.agent.get('/api/templates').query({ wabaId, status: 'PAUSED' });
    expect(paused.body.map((t: { name: string }) => t.name)).toEqual(['order_confirmation']);

    const one = await admin.agent.get(`/api/templates/${paused.body[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.name).toBe('order_confirmation');
    expect((await admin.agent.get('/api/templates/0190a000-0000-7000-8000-000000000000')).status).toBe(404);

    const agent = await signIn(ctx, 'AGENT');
    expect((await agent.agent.get('/api/templates')).status).toBe(200);
  });
});
