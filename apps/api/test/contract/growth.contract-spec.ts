import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignProgressProcessor } from '../../src/modules/campaigns/campaign-progress.processor.js';
import { seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 005 contract tests (T017 and later stories): responses match contracts/growth-api.openapi.yaml.
describe('Campaign growth API contract', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let numberId: string;
  let wabaId: string;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('growth-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx);
    numberId = number.id;
    wabaId = number.wabaId;
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('US1: tracked links, clicks and the public redirect', async () => {
    await check('get', '/tracked-links/config', await call('get', '/tracked-links/config'), 200);

    const template = await seedTemplate(ctx, wabaId, {
      components: [
        { type: 'BODY', text: 'Hi {{1}}' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: `${base}/{{1}}`, example: [`${base}/AbCdEf1234`] }] },
      ],
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BUTTON.0.1', example: `${base}/AbCdEf1234` },
      ],
    });
    const tag = uniq('contract');
    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contact: { connect: { id: contact.id } }, tag: { create: { name: tag } } } });
    const draft = await call('post', '/campaigns', {
      name: `Contract clicks ${randomUUID().slice(0, 6)}`,
      numberId,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
    });
    const id = draft.body.id as string;

    await check('get', '/campaigns/{id}/tracked-links', await call('get', `/campaigns/${id}/tracked-links`), 200);
    await check('get', '/campaigns/{id}/tracked-links', await call('get', `/campaigns/${randomUUID()}/tracked-links`), 404);
    await check('put', '/campaigns/{id}/tracked-links', await call('put', `/campaigns/${id}/tracked-links`, { links: [{ variableKey: 'BODY.1', destination: 'ftp://x' }] }), 422);
    const saved = await call('put', `/campaigns/${id}/tracked-links`, { links: [{ variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale', addCampaignTags: true }] });
    await check('put', '/campaigns/{id}/tracked-links', saved, 200);
    const targetId = (saved.body.links as Array<{ id: string }>)[0]!.id;
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${targetId}`, { destination: 'https://shop.example/sale2' }), 200);
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${targetId}`, { destination: 'nope' }), 422);
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${randomUUID()}`, { destination: 'https://shop.example/x' }), 404);

    expect((await call('post', `/campaigns/${id}/launch`, {})).status).toBe(200);
    await check('put', '/campaigns/{id}/tracked-links', await call('put', `/campaigns/${id}/tracked-links`, { links: [] }), 409);

    const link = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { message: { campaignId: id } } });
    const opened = await request(ctx.server()).get(`/l/${link.code}`).set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Mobile/15E148 Safari/604.1');
    await check('get', '/l/{code}', opened, 302);
    await check('get', '/l/{code}', await request(ctx.server()).get('/l/ZZZZZZZZZZ'), 404);

    await check('get', '/campaigns/{id}/clicks/summary', await call('get', `/campaigns/${id}/clicks/summary`), 200);
    await check('get', '/campaigns/{id}/clicks/summary', await call('get', `/campaigns/${randomUUID()}/clicks/summary`), 404);
    await check('get', '/campaigns/{id}/clicks', await call('get', `/campaigns/${id}/clicks?page=1&pageSize=20`), 200);
    await check('get', '/campaigns/{id}/clicks/export', await call('get', `/campaigns/${id}/clicks/export`), 200);
    await check('get', '/campaigns/{id}/clicks/export', await call('get', `/campaigns/${randomUUID()}/clicks/export`), 404);
  });

  it('US2: retarget groups and drafts', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const source = await ctx.prisma.campaign.create({
      data: {
        name: `Contract retarget ${randomUUID().slice(0, 6)}`,
        numberId,
        templateId: template.id,
        state: 'COMPLETED',
        audienceType: 'ALL_OPTED_IN',
        variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
        createdById: manager.userId,
        launchedAt: new Date(),
        messages: {
          create: {
            origin: 'CAMPAIGN',
            contactId: contact.id,
            phoneE164: contact.phoneE164,
            recipientCountry: 'AE',
            numberId,
            templateId: template.id,
            status: 'DELIVERED',
            deliveredAt: new Date(),
          },
        },
      },
    });
    await check('get', '/campaigns/{id}/retarget-groups', await call('get', `/campaigns/${source.id}/retarget-groups`), 200);
    await check('get', '/campaigns/{id}/retarget-groups', await call('get', `/campaigns/${randomUUID()}/retarget-groups`), 404);
    await check('post', '/campaigns/{id}/retarget', await call('post', `/campaigns/${source.id}/retarget`, { status: 'NOT_CLICKED' }), 201);
    await check('post', '/campaigns/{id}/retarget', await call('post', `/campaigns/${source.id}/retarget`, { status: 'SOMETHING' }), 422);
    await check('post', '/campaigns/{id}/retarget', await call('post', `/campaigns/${randomUUID()}/retarget`, { status: 'CLICKED' }), 404);
    const draft = await call('post', '/campaigns', { name: `Contract draft ${randomUUID().slice(0, 6)}`, numberId, templateId: template.id, audienceType: 'ALL_OPTED_IN' });
    await check('post', '/campaigns/{id}/retarget', await call('post', `/campaigns/${draft.body.id}/retarget`, { status: 'CLICKED' }), 409);
  });

  it('US3: retry plans and rounds', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const draft = await call('post', '/campaigns', { name: `Contract retries ${randomUUID().slice(0, 6)}`, numberId, templateId: template.id, audienceType: 'ALL_OPTED_IN' });
    const id = draft.body.id as string;
    await check('get', '/campaigns/{id}/retry-plan', await call('get', `/campaigns/${id}/retry-plan`), 200);
    await check('get', '/campaigns/{id}/retry-plan', await call('get', `/campaigns/${randomUUID()}/retry-plan`), 404);
    await check('put', '/campaigns/{id}/retry-plan', await call('put', `/campaigns/${id}/retry-plan`, { rounds: 2, delaysMinutes: [30, 60] }), 200);
    await check('put', '/campaigns/{id}/retry-plan', await call('put', `/campaigns/${id}/retry-plan`, { rounds: 3, delaysMinutes: [720, 720, 720] }), 422);
    await check('put', '/campaigns/{id}/retry-plan', await call('put', `/campaigns/${randomUUID()}/retry-plan`, { rounds: 1, delaysMinutes: [30] }), 404);

    // The first pass is over with one failure that may pass: round 1 is scheduled.
    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.campaign.update({
      where: { id },
      data: {
        state: 'RUNNING',
        launchedAt: new Date(),
        messages: {
          create: { origin: 'CAMPAIGN', contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId, templateId: template.id, status: 'FAILED', failureCode: 131016, failedAt: new Date() },
        },
      },
    });
    await check('put', '/campaigns/{id}/retry-plan', await call('put', `/campaigns/${id}/retry-plan`, { rounds: 1, delaysMinutes: [30] }), 409);
    await ctx.app.get(CampaignProgressProcessor).refresh();

    await check('get', '/campaigns/{id}/retry-rounds', await call('get', `/campaigns/${id}/retry-rounds`), 200);
    await check('get', '/campaigns/{id}/retry-rounds', await call('get', `/campaigns/${randomUUID()}/retry-rounds`), 404);
    await check('get', '/retry-rounds', await call('get', '/retry-rounds'), 200);
    await check('post', '/campaigns/{id}/retry-rounds/{round}/cancel', await call('post', `/campaigns/${id}/retry-rounds/1/cancel`), 200);
    await check('post', '/campaigns/{id}/retry-rounds/{round}/cancel', await call('post', `/campaigns/${id}/retry-rounds/1/cancel`), 409);
    await check('post', '/campaigns/{id}/retry-rounds/{round}/cancel', await call('post', `/campaigns/${randomUUID()}/retry-rounds/1/cancel`), 404);
    await check('post', '/campaigns/{id}/retry-rounds/cancel', await call('post', `/campaigns/${id}/retry-rounds/cancel`), 200);
    await check('post', '/campaigns/{id}/retry-rounds/cancel', await call('post', `/campaigns/${randomUUID()}/retry-rounds/cancel`), 404);
  });

  it('US4: drips, steps, lifecycle and enrolments', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const name = `Contract drip ${randomUUID().slice(0, 6)}`;
    const created = await call('post', '/drips', { name, numberId });
    await check('post', '/drips', created, 201);
    await check('post', '/drips', await call('post', '/drips', { name: '', numberId }), 422);
    await check('post', '/drips', await call('post', '/drips', { name, numberId }), 409);
    const id = created.body.id as string;

    await check('get', '/drips', await call('get', '/drips'), 200);
    await check('get', '/drips/{id}', await call('get', `/drips/${id}`), 200);
    await check('get', '/drips/{id}', await call('get', `/drips/${randomUUID()}`), 404);
    await check('patch', '/drips/{id}', await call('patch', `/drips/${id}`, { leaveOnClick: true, quietHours: { from: '22:00', to: '08:00', days: [1, 2, 3, 4, 5] } }), 200);
    await check('patch', '/drips/{id}', await call('patch', `/drips/${id}`, { quietHours: { from: '25:00', to: '08:00', days: [1] } }), 422);
    await check('patch', '/drips/{id}', await call('patch', `/drips/${randomUUID()}`, { leaveOnClick: true }), 404);
    await check('post', '/drips/{id}/activate', await call('post', `/drips/${id}/activate`), 422);
    await check('put', '/drips/{id}/steps', await call('put', `/drips/${id}/steps`, { steps: [] }), 422);
    const steps = await call('put', `/drips/${id}/steps`, { steps: [{ templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes: 0 }] });
    await check('put', '/drips/{id}/steps', steps, 200);
    await check('post', '/drips/{id}/activate', await call('post', `/drips/${id}/activate`), 200);

    await check('post', '/drips/{id}/enrolments/preview', await call('post', `/drips/${id}/enrolments/preview`, { contactIds: [contact.id] }), 200);
    await check('post', '/drips/{id}/enrolments', await call('post', `/drips/${id}/enrolments`, {}), 422);
    await check('post', '/drips/{id}/enrolments', await call('post', `/drips/${id}/enrolments`, { contactIds: [contact.id] }), 200);
    const enrolments = await call('get', `/drips/${id}/enrolments?page=1&pageSize=20`);
    await check('get', '/drips/{id}/enrolments', enrolments, 200);
    const enrolmentId = (enrolments.body.items as Array<{ id: string }>)[0]!.id;
    await check('delete', '/drips/{id}/enrolments/{enrolmentId}', await call('delete', `/drips/${id}/enrolments/${enrolmentId}`), 204);
    await check('delete', '/drips/{id}/enrolments/{enrolmentId}', await call('delete', `/drips/${id}/enrolments/${enrolmentId}`), 409);

    await check('post', '/drips/{id}/pause', await call('post', `/drips/${id}/pause`), 200);
    await check('post', '/drips/{id}/pause', await call('post', `/drips/${id}/pause`), 409);
    await check('post', '/drips/{id}/enrolments', await call('post', `/drips/${id}/enrolments`, { contactIds: [contact.id] }), 409);
    await check('post', '/drips/{id}/activate', await call('post', `/drips/${id}/activate`), 200);
    await check('post', '/drips/{id}/archive', await call('post', `/drips/${id}/archive`), 200);
    await check('delete', '/drips/{id}', await call('delete', `/drips/${id}`), 409);
    await check('patch', '/drips/{id}', await call('patch', `/drips/${id}`, { allowRejoin: true }), 409);

    const draft = await call('post', '/drips', { name: `Contract draft drip ${randomUUID().slice(0, 6)}`, numberId });
    await check('delete', '/drips/{id}', await call('delete', `/drips/${draft.body.id}`), 204);
    await check('delete', '/drips/{id}', await call('delete', `/drips/${randomUUID()}`), 404);
  });

  it('US6: drip results, the contacts behind a count and the export', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const created = await call('post', '/drips', { name: `Contract results ${randomUUID().slice(0, 6)}`, numberId });
    const id = created.body.id as string;
    const steps = await call('put', `/drips/${id}/steps`, { steps: [{ templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes: 0 }] });
    const stepId = (steps.body.stepList as Array<{ id: string }>)[0]!.id;

    await check('get', '/drips/{id}/results', await call('get', `/drips/${id}/results`), 200);
    await check('get', '/drips/{id}/results', await call('get', `/drips/${randomUUID()}/results`), 404);
    await check('get', '/drips/{id}/results/contacts', await call('get', `/drips/${id}/results/contacts?stepId=${stepId}&metric=SENT&page=1&pageSize=20`), 200);
    await check('get', '/drips/{id}/results/contacts', await call('get', `/drips/${randomUUID()}/results/contacts?stepId=${stepId}&metric=SENT`), 404);
    await check('get', '/drips/{id}/results/export', await call('get', `/drips/${id}/results/export?stepId=${stepId}&metric=SKIPPED`), 200);
    await check('get', '/drips/{id}/results/export', await call('get', `/drips/${randomUUID()}/results/export?stepId=${stepId}&metric=SENT`), 404);
  });
});
