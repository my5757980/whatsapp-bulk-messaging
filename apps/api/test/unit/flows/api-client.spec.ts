import nock from 'nock';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiCallError, callApi, createSafeLookup, isBlockedAddress, mapFields, pickPath, RESPONSE_LIMIT_BYTES } from '../../../src/modules/flows/steps/api-client.js';

// 003 T053: the API step client (research R11) - only public HTTPS addresses, checked when the name
// resolves (no DNS-rebinding gap); no redirects; a timeout; a 100 KB cap; JSON replies and mapping.
const BASE = 'https://shop.example.com';
const call = (url: string, extra: Partial<Parameters<typeof callApi>[0]> = {}) => callApi({ method: 'GET', url, headers: {}, timeoutMs: 2_000, ...extra });
const reason = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ApiCallError ? error.reason : `other: ${(error as Error).message}`;
  }
};

describe('blocked addresses', () => {
  it('refuses private, loopback, link-local, shared, multicast and reserved IPv4 addresses', () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.4.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '0.0.0.0', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('refuses the same kinds of IPv6 addresses, including IPv4 hidden inside IPv6', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '2001:db8::1', '64:ff9b::a00:1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('checks every address a name resolves to, so a name cannot point inside', async () => {
    const lookupWith = (addresses: Array<{ address: string; family: number }>) =>
      new Promise<{ error: Error | null; result: unknown }>((resolve) => {
        const lookup = createSafeLookup((_host, _options, callback) => callback(null, addresses));
        lookup('shop.example.com', { all: true }, (error, result) => resolve({ error, result }));
      });
    const inside = await lookupWith([{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }]);
    expect(inside.error).toBeInstanceOf(ApiCallError);
    expect((inside.error as ApiCallError).reason).toBe('BLOCKED_ADDRESS');
    const outside = await lookupWith([{ address: '93.184.216.34', family: 4 }]);
    expect(outside).toEqual({ error: null, result: [{ address: '93.184.216.34', family: 4 }] });
  });

  it('refuses http, private address literals and localhost before connecting', async () => {
    expect(await reason(call('http://shop.example.com/orders'))).toBe('NOT_HTTPS');
    expect(await reason(call('https://10.0.0.5/orders'))).toBe('BLOCKED_ADDRESS');
    expect(await reason(call('https://[::1]/orders'))).toBe('BLOCKED_ADDRESS');
    expect(await reason(call('https://localhost/orders'))).toBe('BLOCKED_ADDRESS');
    expect(await reason(call('https://api.localhost/orders'))).toBe('BLOCKED_ADDRESS');
    expect(await reason(call('not a url'))).toBe('BAD_URL');
  });
});

describe('calls', () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
  });

  it('sends the method, headers and JSON body, and parses a JSON reply', async () => {
    const scope = nock(BASE, { reqheaders: { authorization: 'Bearer abc', 'content-type': 'application/json' } })
      .post('/orders/42/notes', { text: 'hi' })
      .reply(201, { ok: true, order: { status: 'shipped' } });
    const result = await call(`${BASE}/orders/42/notes`, { method: 'POST', headers: { authorization: 'Bearer abc' }, body: JSON.stringify({ text: 'hi' }) });
    expect(result).toMatchObject({ status: 201, body: { ok: true, order: { status: 'shipped' } } });
    expect(scope.isDone()).toBe(true);
  });

  it('does not follow redirects', async () => {
    nock(BASE).get('/moved').reply(302, '', { location: 'https://elsewhere.example.com/' });
    const elsewhere = nock('https://elsewhere.example.com').get('/').reply(200, {});
    expect(await reason(call(`${BASE}/moved`))).toBe('REDIRECT');
    expect(elsewhere.isDone()).toBe(false);
  });

  it('gives up after the timeout', async () => {
    nock(BASE).get('/slow').delay(1_500).reply(200, {});
    expect(await reason(call(`${BASE}/slow`, { timeoutMs: 200 }))).toBe('TIMEOUT');
  });

  it('refuses replies over 100 KB and replies that are not JSON', async () => {
    nock(BASE).get('/big').reply(200, 'x'.repeat(RESPONSE_LIMIT_BYTES + 10), { 'content-type': 'application/json' });
    expect(await reason(call(`${BASE}/big`))).toBe('TOO_LARGE');
    nock(BASE).get('/html').reply(200, '<html>hello</html>', { 'content-type': 'text/html' });
    expect(await reason(call(`${BASE}/html`))).toBe('NOT_JSON');
  });

  it('returns error statuses without parsing them', async () => {
    nock(BASE).get('/broken').reply(500, 'Internal error');
    expect(await call(`${BASE}/broken`)).toMatchObject({ status: 500, body: null });
  });
});

describe('mapping', () => {
  const reply = { order: { status: 'shipped', total: 120.5, paid: true }, items: [{ name: 'Mug' }, { name: 'Tea' }] };

  it('follows dotted paths through objects and arrays', () => {
    expect(pickPath(reply, 'order.status')).toBe('shipped');
    expect(pickPath(reply, 'items.1.name')).toBe('Tea');
    expect(pickPath(reply, 'items.x.name')).toBeUndefined();
    expect(pickPath(reply, 'order.missing.deeper')).toBeUndefined();
  });

  it('maps text, numbers and true/false into answers and skips objects', () => {
    expect(
      mapFields(reply, [
        { path: 'order.status', answerName: 'status' },
        { path: 'order.total', answerName: 'total' },
        { path: 'order.paid', answerName: 'paid' },
        { path: 'items.0.name', answerName: 'first_item' },
        { path: 'order', answerName: 'whole' },
        { path: 'nothing', answerName: 'none' },
      ]),
    ).toEqual({ status: 'shipped', total: 120.5, paid: 'true', first_item: 'Mug' });
  });
});
