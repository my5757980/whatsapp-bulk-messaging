import { describe, expect, it } from 'vitest';
import { redactRequestPath, sanitizeLogObject } from '../../src/common/logging/redaction.js';

// T100: live chat content and push subscriptions never reach the logs (constitution Principle VI).
describe('sanitizeLogObject: live chat (feature 002)', () => {
  it('removes chat text, captions, notes, previews and automatic message content', () => {
    const out = sanitizeLogObject({
      item: { kind: 'NOTE', text: 'Customer is upset, call back', payload: { mentions: ['u1'] } },
      image: { caption: 'Here is my ID card', link: 'https://example.test/x.jpg' },
      note: 'internal remark',
      lastMessagePreview: 'Photo: my passport',
      preview: 'Hello there',
      template: { renderedText: 'Hi Sara, your order 123 is ready' },
      settings: { welcomeContent: { kind: 'TEXT', text: 'Welcome!' }, offHoursContent: { kind: 'TEXT', text: 'Closed' } },
    }) as Record<string, Record<string, unknown> | string>;
    expect((out.item as Record<string, unknown>).text).toBe('[REDACTED]');
    expect((out.item as Record<string, unknown>).payload).toEqual({ mentions: ['u1'] });
    expect((out.image as Record<string, unknown>).caption).toBe('[REDACTED]');
    expect(out.note).toBe('[REDACTED]');
    expect(out.lastMessagePreview).toBe('[REDACTED]');
    expect(out.preview).toBe('[REDACTED]');
    expect((out.template as Record<string, unknown>).renderedText).toBe('[REDACTED]');
    expect(out.settings).toEqual({ welcomeContent: '[REDACTED]', offHoursContent: '[REDACTED]' });
  });

  it('removes push subscription endpoints and keys', () => {
    const out = sanitizeLogObject({
      device: { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BNc...', auth: 'tBH...' } },
      p256dh: 'BNc...',
      auth: 'tBH...',
    }) as Record<string, unknown>;
    expect(out.device).toEqual({ endpoint: '[REDACTED]', keys: '[REDACTED]' });
    expect(out.p256dh).toBe('[REDACTED]');
    expect(out.auth).toBe('[REDACTED]');
  });
});

// 003 T084: flow answers, mapped API fields and stored secret values never reach the logs.
describe('sanitizeLogObject: chatbot flows (feature 003)', () => {
  it('removes session answers, mapped reply fields and stored secret values', () => {
    const out = sanitizeLogObject({
      session: { id: 's1', answers: { email: 'sara@example.com', order: 'A-100' } },
      mapped: { status: 'shipped' },
      flowSecret: { name: 'Shop token', valueEncrypted: 'v1:abc:def:ghi' },
    }) as Record<string, unknown>;
    expect(out.session).toEqual({ id: 's1', answers: '[REDACTED]' });
    expect(out.mapped).toBe('[REDACTED]');
    expect(out.flowSecret).toEqual({ name: 'Shop token', valueEncrypted: '[REDACTED]' });
  });
});

// 004 T106: prompts, knowledge, AI replies, hand-over summaries and remembered values never reach the logs.
describe('sanitizeLogObject: AI agent (feature 004)', () => {
  it('removes prompts, knowledge, replies, summaries and remembered values', () => {
    const out = sanitizeLogObject({
      request: { id: 'r1', prompt: 'Draft a campaign to Sara Ali', system: 'You are the team assistant' },
      knowledge: [{ id: 'k1', text: 'Delivery to Sharjah is AED 15' }],
      chunks: ['Our refund policy'],
      unanswered: { question: 'Do you ship to Oman?', count: 2 },
      source: { kind: 'ANSWER', answer: 'Yes, within 3 days' },
      turn: { result: 'SENT', reply: 'Hi Sara, your order ships today', summary: 'Asked about a late order 10234' },
      remember: [{ key: 'city', value: 'Dubai' }],
      ai: { remembered: { city: 'Dubai' }, pendingConfirmation: { skillId: 'cancel_order' } },
    }) as Record<string, unknown>;
    expect(out.request).toEqual({ id: 'r1', prompt: '[REDACTED]', system: '[REDACTED]' });
    expect(out.knowledge).toBe('[REDACTED]');
    expect(out.chunks).toBe('[REDACTED]');
    expect(out.unanswered).toEqual({ question: '[REDACTED]', count: 2 });
    expect(out.source).toEqual({ kind: 'ANSWER', answer: '[REDACTED]' });
    expect(out.turn).toEqual({ result: 'SENT', reply: '[REDACTED]', summary: '[REDACTED]' });
    expect(out.remember).toBe('[REDACTED]');
    expect(out.ai).toEqual({ remembered: '[REDACTED]', pendingConfirmation: '[REDACTED]' });
  });
});

// T062 (feature 005, FR-041): a tracked-link code opens its recipient's link (and counts a click),
// and a destination can carry personal values, so neither reaches the logs.
describe('sanitizeLogObject: campaign growth (feature 005)', () => {
  it('removes tracked-link codes and destinations', () => {
    const out = sanitizeLogObject({
      linkCode: 'AbCdEf1234',
      link: { id: 'l1', linkCodes: ['AbCdEf1234'], link_code: 'AbCdEf1234' },
      target: { variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale?email=sara@example.com' },
      step: { trackedLinks: [{ variableKey: 'BODY.2', destination: 'https://shop.example/x' }] },
      trackedUrl: 'https://go.company.test/l/AbCdEf1234',
      error: { code: 131026, title: 'Message undeliverable' },
    }) as Record<string, unknown>;
    expect(out.linkCode).toBe('[REDACTED]');
    expect(out.link).toEqual({ id: 'l1', linkCodes: '[REDACTED]', link_code: '[REDACTED]' });
    expect(out.target).toEqual({ variableKey: 'BUTTON.0.1', destination: '[REDACTED]' });
    expect(out.step).toEqual({ trackedLinks: [{ variableKey: 'BODY.2', destination: '[REDACTED]' }] });
    expect(out.trackedUrl).toBe('[REDACTED]');
    // Meta error codes are numbers and stay readable.
    expect(out.error).toEqual({ code: 131026, title: 'Message undeliverable' });
  });

  it('hides codes in logged paths and drops query strings from request paths', () => {
    expect(redactRequestPath('/l/AbCdEf1234')).toBe('/l/[REDACTED]');
    expect(redactRequestPath('/l/AbCdEf1234?utm_source=x')).toBe('/l/[REDACTED]');
    expect(redactRequestPath('/api/campaigns/0190a000-0000-7000-8000-000000000000?page=2')).toBe('/api/campaigns/0190a000-0000-7000-8000-000000000000');
    const out = sanitizeLogObject({ req: { method: 'GET', url: '/l/AbCdEf1234' }, path: '/l/ZZZZZZZZZZ' }) as Record<string, unknown>;
    expect(out.req).toEqual({ method: 'GET', url: '/l/[REDACTED]' });
    expect(out.path).toBe('/l/[REDACTED]');
  });
});

// T015 (feature 006, FR-058): store credentials, PINs and webhook signatures never reach the logs.
describe('sanitizeLogObject: integrations (feature 006)', () => {
  it('removes store credentials, client and consumer secrets, PINs and signatures', () => {
    const out = sanitizeLogObject({
      store: { id: 's1', credentials: { clientId: 'abc', clientSecret: 'shh' }, clientSecret: 'shh', consumerKey: 'ck_1', consumerSecret: 'cs_1' },
      wizard: { phoneNumberId: '123', pin: '123456' },
      headers: { 'webhook-signature': 'v1,abc', 'x-shopify-hmac-sha256': 'abc=', 'x-wc-webhook-signature': 'def=', 'webhook-id': 'evt_1' },
      webhookEndpoint: { id: 'e1', secret: 'whsec_x' },
    }) as Record<string, Record<string, unknown>>;
    expect(out.store).toEqual({ id: 's1', credentials: '[REDACTED]', clientSecret: '[REDACTED]', consumerKey: '[REDACTED]', consumerSecret: '[REDACTED]' });
    expect(out.wizard).toEqual({ phoneNumberId: '123', pin: '[REDACTED]' });
    expect(out.headers).toEqual({ 'webhook-signature': '[REDACTED]', 'x-shopify-hmac-sha256': '[REDACTED]', 'x-wc-webhook-signature': '[REDACTED]', 'webhook-id': 'evt_1' });
    expect(out.webhookEndpoint).toEqual({ id: 'e1', secret: '[REDACTED]' });
  });

  it('removes ads tokens: the one being checked, the page token and the stored ones (feature 007)', () => {
    const out = sanitizeLogObject({
      query: { input_token: 'EAAG-secret', fields: 'scopes' },
      page: { id: 'P1', pageToken: 'p-secret', page_token: 'p-secret' },
      connection: { adAccountId: '111', tokenEnc: 'v1:abc', pageTokenEnc: 'v1:def' },
    }) as Record<string, Record<string, unknown>>;
    expect(out.query).toEqual({ input_token: '[REDACTED]', fields: 'scopes' });
    expect(out.page).toEqual({ id: 'P1', pageToken: '[REDACTED]', page_token: '[REDACTED]' });
    expect(out.connection).toEqual({ adAccountId: '111', tokenEnc: '[REDACTED]', pageTokenEnc: '[REDACTED]' });
  });

  it('removes Stripe keys, signing secrets and the Stripe signature, and hides pay link codes (feature 008)', () => {
    const out = sanitizeLogObject({
      body: { secretKey: 'rk_live_abc', webhookSecret: 'whsec_abc', registerEndpoint: true },
      gateway: { id: 'g1', secretKeyEnc: 'v1:a', webhookSecretEnc: 'v1:b', previousWebhookSecretEnc: 'v1:c', currency: 'aed' },
      headers: { 'stripe-signature': 't=1,v1=abc', 'content-type': 'application/json' },
    }) as Record<string, Record<string, unknown>>;
    expect(out.body).toEqual({ secretKey: '[REDACTED]', webhookSecret: '[REDACTED]', registerEndpoint: true });
    expect(out.gateway).toEqual({ id: 'g1', secretKeyEnc: '[REDACTED]', webhookSecretEnc: '[REDACTED]', previousWebhookSecretEnc: '[REDACTED]', currency: 'aed' });
    expect(out.headers).toEqual({ 'stripe-signature': '[REDACTED]', 'content-type': 'application/json' });
    expect(redactRequestPath('/l/p/Ab12Cd34?paid=1')).toBe('/l/[REDACTED]');
    expect(redactRequestPath('/l/c/Zz99')).toBe('/l/[REDACTED]');
    expect(redactRequestPath('/l/AbCdEf1234')).toBe('/l/[REDACTED]');
  });

  it('removes one-time codes but keeps error codes (feature 009)', () => {
    const out = sanitizeLogObject({ job: { messageId: 'm1', codeEnc: 'v1:abc' }, otp: { otpCode: '482913', otp_code: '482913' }, err: { code: 131026, message: 'undeliverable' } }) as Record<string, Record<string, unknown>>;
    expect(out.job).toEqual({ messageId: 'm1', codeEnc: '[REDACTED]' });
    expect(out.otp).toEqual({ otpCode: '[REDACTED]', otp_code: '[REDACTED]' });
    expect(out.err).toEqual({ code: 131026, message: 'undeliverable' });
  });
});
