import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T062: US6 triggers through webhooks - a template quick-reply on a 001 message, a pattern that
// stores its match, a first-message rule (tag and flow, first message only), exact before contains,
// a "can interrupt" trigger, and refused duplicates and unsafe patterns at publish (FR-019–FR-022).
// Phrases carry a suffix so these published flows never match messages of other test files.
describe('Chatbot flows: template buttons, patterns and first messages (US6)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let manager: SignedInAgent;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, message: Record<string, unknown>) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const text = (body: string) => ({ type: 'text', text: { body } });
  const texts = async (conversationId: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((i) => i.text);
  const reply = (body: string) => [{ id: 'a', type: 'message', text: body, next: null }];
  const keyword = (match: 'EXACT' | 'CONTAINS', phrase: string, canInterrupt = false) => [{ id: 'kw', kind: 'KEYWORD', match, phrases: [phrase], canInterrupt }];
  const flow = async (name: string, triggers: unknown[], steps: unknown[]) => {
    const created = await api('post', '/flows', { name: `${name} ${suffix}` });
    const start = (steps[0] as { id: string }).id;
    expect((await api('put', `/flows/${created.body.id}/draft`, { graph: { version: 1, start, triggers, steps }, draftRevision: 0 })).status).toBe(200);
    return { id: created.body.id as string, published: await api('post', `/flows/${created.body.id}/publish`) };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('starts the linked flow when a customer taps a quick-reply button of a 001 template message', async () => {
    const template = await seedTemplate(ctx, number.wabaId, {
      components: [
        { type: 'BODY', text: 'Still interested in the sofa?' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes, interested' }, { type: 'QUICK_REPLY', text: 'No thanks' }] },
      ],
      variables: [],
    });
    const lead = await flow('Lead follow-up', [{ id: 'tb', kind: 'TEMPLATE_BUTTON', templateId: template.id, buttonText: 'Yes, interested', canInterrupt: false }], reply('Great! A colleague will call you today.'));
    expect(lead.published.status, JSON.stringify(lead.published.body)).toBe(200);
    const missing = await flow('Lead wrong button', [{ id: 'tb', kind: 'TEMPLATE_BUTTON', templateId: template.id, buttonText: 'Maybe later', canInterrupt: false }], reply('x'));
    expect(missing.published.body.problems.map((p: { code: string; triggerId: string }) => `${p.code}:${p.triggerId}`)).toEqual(['MISSING_CONTENT:tb']);

    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    const wamid = `wamid.tpl.${randomUUID()}`;
    await ctx.prisma.message.create({
      data: { origin: 'INBOX', contactId: contact.id, phoneE164: phone, recipientCountry: 'AE', numberId: number.id, templateId: template.id, status: 'SENT', waMessageId: wamid },
    });
    const chat = await inbound(phone, { type: 'button', button: { payload: 'yes', text: 'Yes, interested' }, context: { from: '15550100', id: wamid } });
    expect(await texts(chat.id)).toEqual(['Great! A colleague will call you today.']);
  });

  it('stores the text a pattern matched as an answer, and refuses unsafe patterns', async () => {
    const lookup = await flow('Order lookup', [{ id: 'p', kind: 'PATTERN', pattern: `ref${suffix}-(\\d{4,})`, answerName: 'order', canInterrupt: false }], reply('Looking up order {answer:order}.'));
    expect(lookup.published.status, JSON.stringify(lookup.published.body)).toBe(200);
    const chat = await inbound(uaePhone(), text(`Where is my REF${suffix}-12345 please?`));
    expect(await texts(chat.id)).toEqual(['Looking up order 12345.']);
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(session.answers).toMatchObject({ order: '12345' });

    const unsafe = await flow('Unsafe pattern', [{ id: 'p', kind: 'PATTERN', pattern: '(a+)+$', canInterrupt: false }], reply('x'));
    expect(unsafe.published.status).toBe(422);
    expect(unsafe.published.body.problems.map((p: { code: string }) => p.code)).toEqual(['UNSAFE_PATTERN']);
  });

  it('sets the first-message tag and starts the flow on a first message only', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `ad-sofa-${suffix}` } });
    const sofa = await flow('Sofa ad', [{ id: 'fm', kind: 'FIRST_MESSAGE', match: 'CONTAINS', phrases: [`sofa${suffix}`], tagId: tag.id, startFlow: true }], reply('Thanks for your interest in our sofa!'));
    expect(sofa.published.status, JSON.stringify(sofa.published.body)).toBe(200);

    const phone = uaePhone();
    const chat = await inbound(phone, text(`Hi, I saw your ad for the sofa${suffix}`));
    expect(await texts(chat.id)).toEqual(['Thanks for your interest in our sofa!']);
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(contact.firstMessageTagId).toBe(tag.id);
    const journey = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'FIRST_MESSAGE_TAG_CHANGED' } });
    expect(journey.actorType).toBe('FLOW');
    expect(journey.data).toMatchObject({ to: tag.name, flowId: sofa.id });

    // A later message is not a first message: the rule no longer applies.
    await inbound(phone, text(`sofa${suffix} again`));
    expect(await texts(chat.id)).toEqual(['Thanks for your interest in our sofa!']);
  });

  it('prefers an exact keyword to a contains keyword, and refuses the same exact keyword twice', async () => {
    expect((await flow('Menu exact', keyword('EXACT', `menu${suffix}`), reply('Exact menu'))).published.status).toBe(200);
    expect((await flow('Menu contains', keyword('CONTAINS', `menu${suffix}`), reply('Contains menu'))).published.status).toBe(200);
    expect(await texts((await inbound(uaePhone(), text(`MENU${suffix}`))).id)).toEqual(['Exact menu']);
    expect(await texts((await inbound(uaePhone(), text(`show me the menu${suffix} please`))).id)).toEqual(['Contains menu']);

    const duplicate = await flow('Menu again', keyword('EXACT', `menu${suffix}`), reply('Again'));
    expect(duplicate.published.status).toBe(422);
    expect(duplicate.published.body.problems.map((p: { code: string }) => p.code)).toEqual(['KEYWORD_TAKEN']);
  });

  it('lets a "can interrupt" trigger replace a running session', async () => {
    await flow('Survey', keyword('EXACT', `survey${suffix}`), [
      { id: 'q', type: 'buttons', text: 'How did we do?', buttons: [{ key: 'good', title: 'Good', next: 'bye' }] },
      { id: 'bye', type: 'end' },
    ]);
    await flow('Urgent', keyword('EXACT', `urgent${suffix}`, true), reply('Connecting you with a person now.'));
    const phone = uaePhone();
    const chat = await inbound(phone, text(`survey${suffix}`));
    const survey = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id, status: 'RUNNING' } });
    await inbound(phone, text(`urgent${suffix}`));
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: survey.id } })).toMatchObject({ status: 'ENDED', result: 'INTERRUPTED' });
    expect(await texts(chat.id)).toEqual(['How did we do?', 'Connecting you with a person now.']);
  });
});
