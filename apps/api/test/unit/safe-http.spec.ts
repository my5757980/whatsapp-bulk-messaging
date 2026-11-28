import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress, safeRequest, type SafeHttpError } from '../../src/common/http/safe-http.js';
import { ApiCallError, createSafeLookup } from '../../src/modules/flows/steps/api-client.js';

// T013 (feature 006, research R2): the shared safe client for outbound requests (webhook deliveries,
// stores, the wizard). It keeps the 003 rules and adds the local-test allowance.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 500);
      return;
    }
    if (req.url === '/big') {
      res.end('x'.repeat(10_000));
      return;
    }
    res.writeHead(201, { 'x-test': 'yes' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  nock.cleanAll();
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as SafeHttpError;
  }
  throw new Error('expected a failure');
};

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local, reserved and IPv4-in-IPv6 addresses, and anything that is not an IP', () => {
    for (const address of ['10.1.2.3', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', 'example.com']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '2606:4700:4700::1111']) expect(isBlockedAddress(address), address).toBe(false);
  });
});

describe('safeRequest', () => {
  it('refuses bad addresses, plain http and private or local hosts', async () => {
    expect((await failure(safeRequest({ method: 'POST', url: 'not a url', timeoutMs: 1000 }))).reason).toBe('BAD_URL');
    expect((await failure(safeRequest({ method: 'POST', url: 'http://hooks.example.com/x', timeoutMs: 1000 }))).reason).toBe('NOT_HTTPS');
    expect((await failure(safeRequest({ method: 'POST', url: 'https://10.0.0.1/x', timeoutMs: 1000 }))).reason).toBe('BLOCKED_ADDRESS');
    expect((await failure(safeRequest({ method: 'POST', url: 'https://localhost/x', timeoutMs: 1000 }))).reason).toBe('BLOCKED_ADDRESS');
    expect((await failure(safeRequest({ method: 'POST', url: `${base}/x`, timeoutMs: 1000 }))).reason).toBe('NOT_HTTPS');
  });

  it('sends the request, and returns the status, headers and text of the answer', async () => {
    const scope = nock('https://hooks.example.com', { reqheaders: { 'content-type': 'application/json', 'x-sig': 'v1,abc' } })
      .post('/in', '{"a":1}')
      .reply(202, 'accepted', { 'x-reply': 'yes' });
    const res = await safeRequest({ method: 'POST', url: 'https://hooks.example.com/in', headers: { 'content-type': 'application/json', 'x-sig': 'v1,abc' }, body: '{"a":1}', timeoutMs: 1000 });
    expect(res).toMatchObject({ status: 202, text: 'accepted' });
    expect(res.headers['x-reply']).toBe('yes');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(scope.isDone()).toBe(true);
  });

  it('follows redirects only when asked, checking every address again (feature 009 media addresses)', async () => {
    nock('https://media.example.com').head('/a.pdf').reply(302, '', { location: '/files/a.pdf' }).head('/files/a.pdf').reply(200, '', { 'content-type': 'application/pdf', 'content-length': '2048' });
    const res = await safeRequest({ method: 'HEAD', url: 'https://media.example.com/a.pdf', timeoutMs: 1000, followRedirects: 3 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    nock('https://media.example.com').head('/b.pdf').reply(302, '', { location: 'https://10.0.0.1/b.pdf' });
    expect((await failure(safeRequest({ method: 'HEAD', url: 'https://media.example.com/b.pdf', timeoutMs: 1000, followRedirects: 3 }))).reason).toBe('BLOCKED_ADDRESS');
    nock('https://media.example.com').head('/c.pdf').reply(301, '', { location: 'http://media.example.com/c.pdf' });
    expect((await failure(safeRequest({ method: 'HEAD', url: 'https://media.example.com/c.pdf', timeoutMs: 1000, followRedirects: 3 }))).reason).toBe('NOT_HTTPS');
    nock('https://media.example.com').head('/loop').times(5).reply(302, '', { location: '/loop' });
    expect((await failure(safeRequest({ method: 'HEAD', url: 'https://media.example.com/loop', timeoutMs: 1000, followRedirects: 2 }))).reason).toBe('REDIRECT');
  });

  it('refuses redirects instead of following them', async () => {
    nock('https://hooks.example.com').post('/in').reply(302, '', { location: 'https://elsewhere.example.com/' });
    expect((await failure(safeRequest({ method: 'POST', url: 'https://hooks.example.com/in', body: '{}', timeoutMs: 1000 }))).reason).toBe('REDIRECT');
  });

  it('allows http://localhost only with the local-test allowance, and never in production', async () => {
    expect((await safeRequest({ method: 'GET', url: `${base}/x`, timeoutMs: 1000, allowLocal: true })).status).toBe(201);
    expect((await failure(safeRequest({ method: 'GET', url: 'http://10.0.0.5/x', timeoutMs: 1000, allowLocal: true }))).reason).toBe('NOT_HTTPS');
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect((await failure(safeRequest({ method: 'GET', url: `${base}/x`, timeoutMs: 1000, allowLocal: true }))).reason).toBe('NOT_HTTPS');
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('stops at the timeout and the size cap', async () => {
    expect((await failure(safeRequest({ method: 'GET', url: `${base}/slow`, timeoutMs: 100, allowLocal: true }))).reason).toBe('TIMEOUT');
    expect((await failure(safeRequest({ method: 'GET', url: `${base}/big`, timeoutMs: 1000, maxBytes: 4096, allowLocal: true }))).reason).toBe('TOO_LARGE');
  });
});

describe('003 compatibility', () => {
  it('keeps the flows lookup refusing private answers with the flows error', async () => {
    const result = await new Promise<{ error: Error | null }>((resolve) => {
      const lookup = createSafeLookup((_host, _options, callback) => callback(null, [{ address: '10.1.2.3', family: 4 }]));
      lookup('shop.example.com', { all: true }, (error) => resolve({ error }));
    });
    expect(result.error).toBeInstanceOf(ApiCallError);
    expect((result.error as ApiCallError).reason).toBe('BLOCKED_ADDRESS');
  });
});
