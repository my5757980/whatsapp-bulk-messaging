import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/common/config/config.js';
import { MetaApiError, MetaGraphClient, MetaNetworkError } from '../../src/modules/meta/meta-graph.client.js';

const BASE = 'https://graph.facebook.test';
const config = { META_GRAPH_BASE_URL: BASE, META_GRAPH_API_VERSION: 'v27.0' } as AppConfig;
const client = new MetaGraphClient(config, { timeoutMs: 150 });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('MetaGraphClient', () => {
  it('sends a template message and returns the wamid', async () => {
    nock(BASE)
      .post('/v27.0/111/messages', (body: Record<string, unknown>) => {
        const template = body.template as { name: string; language: { code: string } };
        return body.messaging_product === 'whatsapp' && body.type === 'template' && body.to === '971501234567' && template.name === 'promo' && template.language.code === 'en_US';
      })
      .matchHeader('authorization', 'Bearer tok')
      .reply(200, { messaging_product: 'whatsapp', contacts: [{ input: '971501234567', wa_id: '971501234567' }], messages: [{ id: 'wamid.ABC' }] });

    const result = await client.sendTemplate('tok', '111', {
      to: '971501234567',
      template: { name: 'promo', language: { code: 'en_US' }, components: [] },
    });
    expect(result).toEqual({ waMessageId: 'wamid.ABC' });
  });

  it('parses Graph errors into MetaApiError', async () => {
    nock(BASE)
      .post('/v27.0/111/messages')
      .reply(400, { error: { message: '(#131026) Message undeliverable', type: 'OAuthException', code: 131026, error_subcode: 2494010, fbtrace_id: 'TRACE' } });

    const error = await client
      .sendTemplate('tok', '111', { to: '1', template: { name: 'x', language: { code: 'en' }, components: [] } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ httpStatus: 400, code: 131026, subcode: 2494010, fbtraceId: 'TRACE' });
  });

  it('pages through all message templates with the after cursor', async () => {
    nock(BASE)
      .get('/v27.0/WABA/message_templates')
      .query((q) => !q.after)
      .reply(200, { data: [{ id: 't1', name: 'a', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [] }], paging: { cursors: { after: 'C1' }, next: `${BASE}/next` } })
      .get('/v27.0/WABA/message_templates')
      .query((q) => q.after === 'C1')
      .reply(200, { data: [{ id: 't2', name: 'b', language: 'en', status: 'PENDING', category: 'UTILITY', components: [] }], paging: { cursors: { after: 'C2' } } });

    const templates = await client.listAllTemplates('tok', 'WABA');
    expect(templates.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('creates and deletes templates', async () => {
    nock(BASE)
      .post('/v27.0/WABA/message_templates', (body: Record<string, unknown>) => body.name === 'promo' && body.category === 'MARKETING')
      .reply(200, { id: 'T9', status: 'PENDING', category: 'MARKETING' })
      .delete('/v27.0/WABA/message_templates')
      .query({ name: 'promo' })
      .reply(200, { success: true });

    await expect(
      client.createTemplate('tok', 'WABA', { name: 'promo', language: 'en_US', category: 'MARKETING', components: [] }),
    ).resolves.toEqual({ id: 'T9', status: 'PENDING', category: 'MARKETING' });
    await expect(client.deleteTemplate('tok', 'WABA', 'promo')).resolves.toBeUndefined();
  });

  it('reads phone number details', async () => {
    nock(BASE)
      .get('/v27.0/111')
      .query((q) => typeof q.fields === 'string' && q.fields.includes('quality_rating'))
      .reply(200, { id: '111', display_phone_number: '+971 50 000 0000', verified_name: 'Acme', quality_rating: 'GREEN', status: 'CONNECTED', throughput: { level: 'STANDARD' } });

    await expect(client.getPhoneNumber('tok', '111')).resolves.toMatchObject({
      id: '111',
      displayPhoneNumber: '+971 50 000 0000',
      verifiedName: 'Acme',
      qualityRating: 'GREEN',
      throughputLevel: 'STANDARD',
    });
  });

  it('uploads media for a number', async () => {
    nock(BASE).post('/v27.0/111/media').reply(200, { id: 'MEDIA1' });
    await expect(client.uploadMedia('tok', '111', Buffer.from('img'), 'image/png', 'a.png')).resolves.toEqual({ id: 'MEDIA1' });
  });

});

// Real sockets (not nock) so the transport semantics match production fetch/undici.
describe('MetaGraphClient network failures', () => {
  const payload = { to: '1', template: { name: 'x', language: { code: 'en' }, components: [] } };
  let server: Server | undefined;

  beforeAll(() => nock.enableNetConnect('127.0.0.1'));
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('marks refused connections as pre-send network errors (safe to retry)', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: p } = probe.address() as AddressInfo;
        probe.close(() => resolve(p)); // port is now closed -> ECONNREFUSED
      });
    });
    const local = new MetaGraphClient({ META_GRAPH_BASE_URL: `http://127.0.0.1:${port}`, META_GRAPH_API_VERSION: 'v27.0' } as AppConfig);
    const error = await local.sendTemplate('tok', '111', payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaNetworkError);
    expect((error as MetaNetworkError).phase).toBe('pre_send');
  });

  it('marks timeouts after the request was sent as ambiguous (never retried)', async () => {
    server = createServer((_req, res) => setTimeout(() => res.end('{"messages":[{"id":"late"}]}'), 1000));
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)),
    );
    const slow = new MetaGraphClient(
      { META_GRAPH_BASE_URL: `http://127.0.0.1:${port}`, META_GRAPH_API_VERSION: 'v27.0' } as AppConfig,
      { timeoutMs: 150 },
    );
    const error = await slow.sendTemplate('tok', '111', payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaNetworkError);
    expect((error as MetaNetworkError).phase).toBe('ambiguous');
  });
});
