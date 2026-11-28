import { randomInt } from 'node:crypto';
import { messageWithRef } from '@wbm/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatWidgetCheckProcessor } from '../../src/modules/integrations/chat-widgets/chat-widget-check.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, seedNumber, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T081 (feature 009 US8, research R15, contracts/website-button.md): website chat buttons, their public
// config, page counts through the 006 chat links, chat starts per rule, and the disconnection notice.
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Website chat buttons (009 US8)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  const base = (process.env.PUBLIC_LINK_BASE_URL as string).replace(/\/+$/, '');

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('x-csrf-token', who.csrf).send(body ?? {});
  };
  const input = (overrides: Record<string, unknown> = {}) => ({
    name: `Shop button ${digits(6)}`,
    numberId: number.id,
    look: { colour: '#0A7B55', buttonText: 'Chat with us', corner: 'BOTTOM_RIGHT', offsetX: 20, offsetY: 20, radius: 24 },
    brandName: 'Lamp & Co',
    brandImageAssetId: null,
    greeting: 'Hi! How can we help?',
    message: 'Hello, I have a question',
    rules: [
      { match: 'PREFIX', value: '/Products', hide: false, greeting: 'Questions about this product?', message: 'Hi, I am looking at a product' },
      { match: 'EXACT', value: '/checkout', hide: true },
    ],
    ...overrides,
  });
  const config = (key: string) => request(ctx.server()).get(`/l/w/${key}/config.json`);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
  });
  afterAll(async () => ctx.close());

  it('creates a button with its own chat links, hidden from the chat links list; an update keeps the key and the snippet', async () => {
    const created = await api(manager, 'post', '/chat-widgets', input());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const w = created.body;
    expect(w).toMatchObject({ key: expect.stringMatching(/^[A-Za-z0-9]{12}$/), status: 'ACTIVE', numberConnected: true, last30Days: { opens: 0, chatsStarted: 0 } });
    expect(w.snippet).toBe(`<script async src="${base}/w/widget.js" data-key="${w.key}"></script>`);
    expect(w.rules[0]).toMatchObject({ id: expect.any(String), match: 'PREFIX', value: '/products', message: 'Hi, I am looking at a product' });
    expect(w.rules[1]).toMatchObject({ match: 'EXACT', value: '/checkout', hide: true, message: null });

    const links = await ctx.prisma.chatLink.findMany({ where: { widgetId: w.id, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    expect(links.map((l) => [l.source, l.widgetRuleId, l.message])).toEqual([
      ['WIDGET', null, 'Hello, I have a question'],
      ['WIDGET', w.rules[0].id, 'Hi, I am looking at a product'],
    ]);
    const list = await api(manager, 'get', '/chat-links');
    const listed = (Array.isArray(list.body) ? list.body : list.body.items) as Array<{ id: string }>;
    expect(listed.some((l) => links.some((x) => x.id === l.id))).toBe(false);
    expect((await api(manager, 'get', `/chat-links/${links[0]!.id}`)).status).toBe(404);

    // The rule loses its own message: its link stops; the default link keeps its code with the new message.
    const updated = await api(manager, 'put', `/chat-widgets/${w.id}`, input({ name: w.name, message: 'Hello again', rules: [{ id: w.rules[0].id, match: 'PREFIX', value: '/products', hide: false, greeting: 'Questions?', message: null }] }));
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ key: w.key, snippet: w.snippet });
    const after = await ctx.prisma.chatLink.findMany({ where: { widgetId: w.id } });
    expect(after.find((l) => l.widgetRuleId === null)).toMatchObject({ code: links[0]!.code, message: 'Hello again', deletedAt: null });
    expect(after.find((l) => l.widgetRuleId === w.rules[0].id)?.deletedAt).not.toBeNull();

    const taken = await api(manager, 'post', '/chat-widgets', input({ name: w.name }));
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NAME_TAKEN');
    const offline = await seedNumber(ctx, { connectionStatus: 'ERROR' });
    const refused = await api(manager, 'post', '/chat-widgets', input({ numberId: offline.id }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('NUMBER_NOT_CONNECTED');
    expect((await api(agent, 'post', '/chat-widgets', input())).status).toBe(403);
    expect((await api(agent, 'get', '/chat-widgets')).status).toBe(200);
  });

  it('serves the public config (CORS, no cookies, ETag), hides it when paused or disconnected, 404 once deleted, and the image and script', async () => {
    const image = await manager.agent.post('/api/media').set('x-csrf-token', manager.csrf).field('purpose', 'TEMPLATE_SAMPLE').attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    const own = await seedNumber(ctx);
    const w = (await api(manager, 'post', '/chat-widgets', input({ numberId: own.id, brandImageAssetId: image.body.id }))).body;
    const res = await config(w.key);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toMatchObject({
      hidden: false,
      brandName: 'Lamp & Co',
      greeting: 'Hi! How can we help?',
      brandImageUrl: expect.stringContaining(`/w/${w.key}/image`),
      startUrl: expect.stringMatching(/\/c\/[A-Za-z0-9]{10}$/),
      rules: [
        { match: 'PREFIX', value: '/products', hide: false, greeting: 'Questions about this product?', startUrl: expect.stringMatching(/\/c\/[A-Za-z0-9]{10}$/) },
        { match: 'EXACT', value: '/checkout', hide: true, startUrl: null },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(own.phoneNumberId);
    expect((await config(w.key).set('If-None-Match', res.headers.etag as string)).status).toBe(304);

    const logo = await request(ctx.server()).get(`/l/w/${w.key}/image`);
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toMatch(/image\/png/);
    const script = await request(ctx.server()).get('/l/w/widget.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.headers['cache-control']).toBe('public, max-age=86400');
    expect(script.text).toContain('__wbmChatButton');

    expect((await api(manager, 'post', `/chat-widgets/${w.id}/pause`)).body.status).toBe('PAUSED');
    expect((await config(w.key)).body).toEqual({ hidden: true });
    expect((await api(manager, 'post', `/chat-widgets/${w.id}/resume`)).body.status).toBe('ACTIVE');
    await ctx.prisma.whatsAppNumber.update({ where: { id: own.id }, data: { connectionStatus: 'ERROR' } });
    expect((await config(w.key)).body).toEqual({ hidden: true });
    const resume = await api(manager, 'post', `/chat-widgets/${w.id}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe('NUMBER_NOT_CONNECTED');
    await ctx.prisma.whatsAppNumber.update({ where: { id: own.id }, data: { connectionStatus: 'CONNECTED' } });

    expect((await api(manager, 'delete', `/chat-widgets/${w.id}`)).status).toBe(204);
    expect((await config(w.key)).status).toBe(404);
    expect((await config('Zz9Zz9Zz9Zz9')).status).toBe(404);
  });

  it('counts the page of an open from its own button, and the chat start for the rule', async () => {
    const w = (await api(manager, 'post', '/chat-widgets', input())).body;
    const rule = await ctx.prisma.chatLink.findFirstOrThrow({ where: { widgetId: w.id, widgetRuleId: w.rules[0].id } });
    const open = (query: string, ua = PHONE_UA) => request(ctx.server()).get(`/l/c/${rule.code}${query}`).set('User-Agent', ua);

    const first = await open(`?w=${w.key}&p=${encodeURIComponent('/products/lamp?utm=x')}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain(encodeURIComponent(messageWithRef(rule.message, rule.ref)));
    await open(`?w=WrongKey0000&p=${encodeURIComponent('/elsewhere')}`);
    await open(`?w=${w.key}&p=${encodeURIComponent('/products/lamp')}`, 'WhatsApp/2.24.20.72 A');
    const opens = await ctx.prisma.chatLinkOpen.findMany({ where: { chatLinkId: rule.id }, orderBy: { openedAt: 'asc' } });
    expect(opens.map((o) => o.page)).toEqual(['/products/lamp', null]);

    const phone = uaePhone();
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), messageWithRef(rule.message, rule.ref))));
    const start = await ctx.prisma.chatLinkStart.findFirstOrThrow({ where: { chatLinkId: rule.id } });
    expect(start).toMatchObject({ newContact: true });
    const event = await ctx.prisma.conversationEvent.findFirst({ where: { conversationId: start.conversationId!, type: 'CHAT_LINK_STARTED' } });
    expect(event?.data).toMatchObject({ chatLinkName: 'From the website button · Pages starting with /products' });

    const stats = await api(manager, 'get', `/chat-widgets/${w.id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.opensByPage).toContainEqual({ page: '/products/lamp', opens: 1 });
    expect(stats.body.chatsByRule).toEqual([{ ruleId: w.rules[0].id, label: 'Pages starting with /products', chatsStarted: 1, newContacts: 1 }]);
    expect((await api(manager, 'get', `/chat-widgets/${w.id}`)).body.last30Days).toEqual({ opens: 2, chatsStarted: 1 });
  });

  it('tells admins once per disconnection, refuses bursts, and audits the changes', async () => {
    const own = await seedNumber(ctx);
    const w = (await api(manager, 'post', '/chat-widgets', input({ numberId: own.id }))).body;
    await ctx.prisma.whatsAppNumber.update({ where: { id: own.id }, data: { connectionStatus: 'ERROR' } });
    const check = ctx.app.get(ChatWidgetCheckProcessor);
    await check.check();
    await check.check();
    const notices = await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'CHAT_WIDGET_NUMBER_DISCONNECTED', link: `/website-button/${w.id}` } });
    expect(notices).toBe(1);
    await ctx.prisma.whatsAppNumber.update({ where: { id: own.id }, data: { connectionStatus: 'CONNECTED' } });
    await check.check();
    expect((await ctx.prisma.chatWidget.findUniqueOrThrow({ where: { id: w.id } })).disconnectNotifiedAt).toBeNull();

    // The 005 per-client limit on the public config.
    const msLeft = 60_000 - (Date.now() % 60_000);
    if (msLeft < 10_000) await new Promise((resolve) => setTimeout(resolve, msLeft + 200));
    const client = `203.0.113.${randomInt(1, 254)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) statuses.push((await config(w.key).set('X-Forwarded-For', client)).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);

    expect(await ctx.prisma.auditLog.count({ where: { action: 'chat_widget.created', targetId: w.id } })).toBe(1);
  });
});
