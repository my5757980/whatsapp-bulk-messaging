import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T070 (feature 006 US7, FR-045 - FR-050, research R12): chat links with a short link and a reference,
// the /l/c redirect with the 005 preview, robot and rate rules, chat starts matched by reference that
// tag the contact and start the link's flow before keyword flows (never over a running flow or a
// member's chat), results per day, the contacts list, tagging, the export and QR images.

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const WHATSAPP_PREVIEW_UA = 'WhatsApp/2.24.20.72 A';
const REF_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
type Json = Record<string, unknown>;

describe('Chat links and QR codes (006 US7)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let link: Json;
  let tagId: string;
  let welcomeFlowId: string;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const word = `counter${suffix}`;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;
  const phones = { fresh: uaePhone(), edited: uaePhone(), known: uaePhone(), quiz: uaePhone(), member: uaePhone() };

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const open = (code: string, userAgent = PHONE_UA) => request(ctx.server()).get(`/l/c/${code}`).set('User-Agent', userAgent);
  const codeOf = (l: Json) => String(l.shortUrl).split('/').pop()!;
  const prefilled = (l: Json) => new URL(String(l.whatsappUrl)).searchParams.get('text')!;
  const send = async (phone: string, text: string) => {
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text)));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const replies = async (conversationId: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((m) => m.text);
  const flow = async (name: string, graph: object, publish = true) => {
    const id = (await api(manager, 'post', '/flows', { name: `${name} ${suffix}` })).body.id as string;
    expect((await api(manager, 'put', `/flows/${id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    if (publish) expect((await api(manager, 'post', `/flows/${id}/publish`)).status).toBe(200);
    return id;
  };
  const keyword = (phrase: string, match: 'EXACT' | 'CONTAINS') => [{ id: 'kw', kind: 'KEYWORD', match, phrases: [phrase], canInterrupt: false }];
  const startsOf = (phone: string) => ctx.prisma.chatLinkStart.findMany({ where: { chatLinkId: String(link.id), contact: { phoneE164: phone } } });
  const hasTag = async (phone: string) => (await ctx.prisma.contactTag.count({ where: { tagId, contact: { phoneE164: phone } } })) === 1;

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
    tagId = (await ctx.prisma.tag.create({ data: { name: uniq('counter-') } })).id;
    welcomeFlowId = await flow('Welcome', { version: 1, start: 'a', triggers: keyword(`never${suffix}`, 'EXACT'), steps: [{ id: 'a', type: 'message', text: 'Welcome to the shop counter!', next: null }] });
    // A keyword flow that the pre-filled message would start if the link's flow did not come first.
    await flow('Counter keyword', { version: 1, start: 'a', triggers: keyword(word, 'CONTAINS'), steps: [{ id: 'a', type: 'message', text: 'Keyword flow reply', next: null }] });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a link with a short link and a reference, and checks names, flows and tags', async () => {
    const res = await api(manager, 'post', '/chat-links', { name: `Shop counter ${suffix}`, numberId: number.id, message: `I saw the poster at ${word}`, flowId: welcomeFlowId, tagId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    link = res.body as Json;
    expect(link).toMatchObject({ status: 'ACTIVE', opens: 0, chatsStarted: 0, flowId: welcomeFlowId, tagId, numberId: number.id });
    expect(String(link.ref)).toMatch(REF_ALPHABET);
    expect(String(link.shortUrl)).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/c/[A-Za-z0-9]{10}$`));
    expect(link.whatsappUrl).toBe(`https://wa.me/15550100001?text=${encodeURIComponent(`I saw the poster at ${word} (ref ${String(link.ref)})`)}`);
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'chat_link.created', targetId: String(link.id) } })).toBeTruthy();

    const again = await api(manager, 'post', '/chat-links', { name: `shop COUNTER ${suffix}`, numberId: number.id, message: 'Hi' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NAME_TAKEN');
    const draft = await flow('Draft only', { version: 1, start: 'a', triggers: keyword(`draft${suffix}`, 'EXACT'), steps: [{ id: 'a', type: 'message', text: 'Draft', next: null }] }, false);
    const elsewhere = await flow('Other number', { version: 1, start: 'a', triggers: keyword(`other${suffix}`, 'EXACT'), steps: [{ id: 'a', type: 'message', text: 'Other', next: null }] });
    await ctx.prisma.flow.update({ where: { id: elsewhere }, data: { allNumbers: false } });
    for (const [flowId, issue] of [
      [draft, 'is not published'],
      [elsewhere, "does not run on the link's number"],
    ] as const) {
      const bad = await api(manager, 'post', '/chat-links', { name: uniq('Bad '), numberId: number.id, message: 'Hi', flowId });
      expect(bad.status).toBe(422);
      expect(bad.body.details).toContainEqual({ field: 'flowId', issue });
    }
    const noTag = await api(manager, 'post', '/chat-links', { name: uniq('Bad '), numberId: number.id, message: 'Hi', tagId: randomUUID() });
    expect(noTag.status).toBe(422);
    expect((await api(agent, 'post', '/chat-links', { name: uniq('Agent '), numberId: number.id, message: 'Hi' })).status).toBe(403);
  });

  it('sends people on to WhatsApp, counts openings but not previews, and shows a page for links not in use', async () => {
    const code = codeOf(link);
    const opened = await open(code);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toBe(link.whatsappUrl);
    expect(opened.headers['cache-control']).toBe('no-store');
    expect(opened.headers['referrer-policy']).toBe('no-referrer');
    expect((await open(code, DESKTOP_UA)).status).toBe(302);
    expect((await open(code, WHATSAPP_PREVIEW_UA)).status).toBe(302);
    expect((await request(ctx.server()).head(`/l/c/${code}`).set('User-Agent', PHONE_UA)).status).toBe(302);
    const opens = await ctx.prisma.chatLinkOpen.findMany({ where: { chatLinkId: String(link.id) }, orderBy: { openedAt: 'asc' } });
    expect(opens.map((o) => o.device).sort()).toEqual(['DESKTOP', 'MOBILE']);

    expect((await api(manager, 'patch', `/chat-links/${String(link.id)}`, { status: 'OFF' })).status).toBe(200);
    const off = await open(code);
    expect(off.status).toBe(404);
    expect(off.text).toContain('no longer in use');
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'chat_link.turned_off', targetId: String(link.id) } })).toBeTruthy();
    expect((await api(manager, 'patch', `/chat-links/${String(link.id)}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await open(code, WHATSAPP_PREVIEW_UA)).status).toBe(302);

    const gone = (await api(manager, 'post', '/chat-links', { name: uniq('Gone '), numberId: number.id, message: 'Bye' })).body as Json;
    expect((await api(manager, 'delete', `/chat-links/${String(gone.id)}`)).status).toBe(204);
    expect((await open(codeOf(gone))).status).toBe(404);
    expect((await api(manager, 'get', `/chat-links/${String(gone.id)}`)).status).toBe(404);
    const unknown = await open('Zz9Zz9Zz9Z');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain('not available');
    expect(await ctx.prisma.chatLinkOpen.count({ where: { chatLinkId: String(link.id) } })).toBe(2);

    // The 005 per-client limit: a burst from one client address is refused for the rest of the minute.
    const msLeft = 60_000 - (Date.now() % 60_000);
    if (msLeft < 10_000) await new Promise((resolve) => setTimeout(resolve, msLeft + 200));
    const client = `203.0.113.${randomInt(1, 254)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) statuses.push((await request(ctx.server()).get('/l/c/Zz9Zz9Zz9Z').set('X-Forwarded-For', client)).status);
    expect(statuses.slice(0, 120).every((s) => s === 404)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it('counts the pre-filled message as a chat start, tags the contact and starts the link flow before keyword flows', async () => {
    const chat = await send(phones.fresh, prefilled(link));
    expect(await replies(chat.id)).toEqual(['Welcome to the shop counter!']);
    expect(await startsOf(phones.fresh)).toMatchObject([{ newContact: true, conversationId: chat.id }]);
    expect(await hasTag(phones.fresh)).toBe(true);
    expect(await ctx.prisma.conversationEvent.findFirst({ where: { conversationId: chat.id, type: 'CHAT_LINK_STARTED' } })).toMatchObject({ actorType: 'CUSTOMER', data: { chatLinkName: link.name, newContact: true } });
    expect(await ctx.prisma.flowSession.findFirst({ where: { conversationId: chat.id } })).toMatchObject({ flowId: welcomeFlowId, triggerKey: 'chat_link' });

    // The same message again on the same day is not a second start.
    await send(phones.fresh, prefilled(link));
    expect(await startsOf(phones.fresh)).toHaveLength(1);

    // An edited reference matches nothing: a normal customer message, here for the keyword flow.
    const edited = await send(phones.edited, prefilled(link).replace(/ \(ref [A-Z0-9]{6}\)$/, ''));
    expect(await replies(edited.id)).toEqual(['Keyword flow reply']);
    expect(await startsOf(phones.edited)).toHaveLength(0);
    expect(await hasTag(phones.edited)).toBe(false);

    // A contact the company had already is a start, but not a new contact.
    await seedContact(ctx, phones.known, { consentStatus: 'UNKNOWN' });
    await send(phones.known, prefilled(link));
    expect(await startsOf(phones.known)).toMatchObject([{ newContact: false }]);
  });

  it('never interrupts a running flow or a member chat, but still counts and tags', async () => {
    await flow('Quiz', { version: 1, start: 'q', triggers: keyword(`quiz${suffix}`, 'EXACT'), steps: [{ id: 'q', type: 'question', text: 'What is your name?', next: 'done' }, { id: 'done', type: 'message', text: 'Thanks!', next: null }] });
    const quiz = await send(phones.quiz, `quiz${suffix}`);
    expect(await replies(quiz.id)).toEqual(['What is your name?']);
    await send(phones.quiz, prefilled(link));
    expect(await replies(quiz.id)).toEqual(['What is your name?', 'Thanks!']);
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: quiz.id, flowId: welcomeFlowId } })).toBe(0);
    expect(await startsOf(phones.quiz)).toHaveLength(1);
    expect(await hasTag(phones.quiz)).toBe(true);

    const chat = await send(phones.member, `zq${suffix}`);
    const before = await replies(chat.id);
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { state: 'INTERVENED', intervenedById: manager.userId, intervenedAt: new Date() } });
    await send(phones.member, prefilled(link));
    expect(await ctx.prisma.flowSession.count({ where: { conversationId: chat.id } })).toBe(0);
    expect(await replies(chat.id)).toEqual(before);
    expect(await startsOf(phones.member)).toMatchObject([{ newContact: false }]);
    expect(await hasTag(phones.member)).toBe(true);
  });

  it('shows results per day and the contacts, who can be tagged and exported', async () => {
    const id = String(link.id);
    const results = await api(manager, 'get', `/chat-links/${id}/results`);
    expect(results.status).toBe(200);
    expect(results.body.totals).toEqual({ opens: 2, chatsStarted: 4, newContacts: 1 });
    expect(results.body.days).toHaveLength(1);
    expect(results.body.days[0]).toMatchObject({ opens: 2, chatsStarted: 4, newContacts: 1 });
    expect((await api(manager, 'get', `/chat-links/${id}`)).body).toMatchObject({ opens: 2, chatsStarted: 4 });

    const listed = await api(manager, 'get', `/chat-links/${id}/contacts?pageSize=10`);
    expect(listed.body.total).toBe(4);
    expect((listed.body.items as Array<{ phone: string }>).map((c) => c.phone).sort()).toEqual([phones.fresh, phones.known, phones.quiz, phones.member].sort());
    const masked = await api(agent, 'get', `/chat-links/${id}/contacts?pageSize=10`);
    expect(masked.status).toBe(200);
    expect((masked.body.items as Array<{ phone: string }>).every((c) => !Object.values(phones).includes(c.phone))).toBe(true);

    const tagName = uniq('mall-');
    const tagged = await api(manager, 'post', `/chat-links/${id}/contacts/tag`, { tag: tagName });
    expect(tagged.status).toBe(200);
    expect(tagged.body).toEqual({ tagged: 4 });
    expect(await ctx.prisma.contactTag.count({ where: { tag: { name: tagName } } })).toBe(4);
    expect((await api(manager, 'post', `/chat-links/${id}/contacts/tag`, { tag: tagName })).body).toEqual({ tagged: 0 });

    const csv = await api(admin, 'get', `/chat-links/${id}/contacts/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('phone,name,first_started_at,last_started_at,chats_started');
    expect(lines).toHaveLength(5);
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'data.exported', targetId: id } })).toBeTruthy();
    expect((await api(agent, 'get', `/chat-links/${id}/contacts/export`)).status).toBe(403);
  });

  it('makes QR images of the short link as SVG and PNG', async () => {
    const id = String(link.id);
    const svg = await api(manager, 'get', `/chat-links/${id}/qr?format=svg&size=512`).buffer(true);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(Buffer.isBuffer(svg.body) ? svg.body.toString('utf8') : svg.text).toContain('<svg');
    const png = await api(manager, 'get', `/chat-links/${id}/qr?format=png&size=256`)
      .buffer(true)
      .parse((res, done) => {
        const stream = res as unknown as NodeJS.ReadableStream;
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect((png.body as Buffer).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect((await api(manager, 'get', `/chat-links/${id}/qr?size=64`)).status).toBe(422);
  });
});
