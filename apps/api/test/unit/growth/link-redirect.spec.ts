import { describe, expect, it, vi } from 'vitest';
import { LinkRateLimiter } from '../../../src/modules/growth/links/link-rate-limiter.js';
import { LinkRedirectService, type LinkRequest } from '../../../src/modules/growth/links/link-redirect.service.js';
import { finalDestination, type ResolvedLink } from '../../../src/modules/growth/links/link-resolver.js';

// T015 (feature 005, FR-003 - FR-005, research R1, R3): the public tracked-link redirect.
const PHONE = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

const link: ResolvedLink = {
  linkId: 'link-1',
  messageId: 'message-1',
  contactId: 'contact-1',
  targetId: 'target-1',
  campaignId: 'campaign-1',
  dripStepId: null,
  dripId: null,
  ownerName: 'Summer Sale',
  destination: 'https://shop.example/sale',
};

function setup(options: { found?: ResolvedLink | null; allow?: boolean; recordFails?: boolean } = {}) {
  const resolver = { resolve: vi.fn(async () => (options.found === undefined ? link : options.found)) };
  const recorder = {
    record: vi.fn(async () => {
      if (options.recordFails) throw new Error('database unavailable');
    }),
  };
  const limiter = { allow: vi.fn(async () => options.allow ?? true) };
  const service = new LinkRedirectService(resolver as never, recorder as never, limiter as never);
  return { service, resolver, recorder, limiter };
}

const request = (overrides: Partial<LinkRequest> = {}): LinkRequest => ({ method: 'GET', userAgent: PHONE, ip: '203.0.113.7', ...overrides });

describe('LinkRedirectService', () => {
  it('sends a click on to the destination without caching or a referrer, and records it with the device kind only', async () => {
    const { service, recorder } = setup();
    const res = await service.open('AbCdEf1234', request());
    expect(res.status).toBe(302);
    expect(res.headers).toMatchObject({ Location: 'https://shop.example/sale', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    // The visitor's address never reaches the click record (FR-003).
    expect(recorder.record).toHaveBeenCalledWith(link, 'MOBILE');
    expect(JSON.stringify(recorder.record.mock.calls)).not.toContain('203.0.113.7');
  });

  it('redirects link previews, robots and HEAD requests without recording a click', async () => {
    const { service, recorder } = setup();
    for (const req of [request({ userAgent: 'WhatsApp/2.24.20.72 A' }), request({ userAgent: 'facebookexternalhit/1.1' }), request({ method: 'HEAD' }), request({ purpose: 'prefetch' })]) {
      const res = await service.open('AbCdEf1234', req);
      expect(res.status).toBe(302);
      expect(res.headers.Location).toBe('https://shop.example/sale');
    }
    expect(recorder.record).not.toHaveBeenCalled();
  });

  it('shows a not-available page for unknown or malformed codes and sends nobody onward', async () => {
    const unknown = setup({ found: null });
    const res = await unknown.service.open('ZZZZZZZZZZ', request());
    expect(res.status).toBe(404);
    expect(res.headers.Location).toBeUndefined();
    expect(res.headers['Content-Type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/not available/i);
    expect(unknown.recorder.record).not.toHaveBeenCalled();

    const malformed = setup();
    expect((await malformed.service.open('abc', request())).status).toBe(404);
    expect((await malformed.service.open('AbCdEf123!', request())).status).toBe(404);
    expect(malformed.resolver.resolve).not.toHaveBeenCalled();
  });

  it('answers 429 when one client opens too many links', async () => {
    const { service, resolver } = setup({ allow: false });
    const res = await service.open('AbCdEf1234', request());
    expect(res.status).toBe(429);
    expect(res.headers.Location).toBeUndefined();
    expect(res.headers['Retry-After']).toBeDefined();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('still sends the visitor on when recording the click fails', async () => {
    const { service } = setup({ recordFails: true });
    const res = await service.open('AbCdEf1234', request());
    expect(res.status).toBe(302);
    expect(res.headers.Location).toBe('https://shop.example/sale');
  });
});

describe('finalDestination', () => {
  it('adds the campaign tags only when they are switched on', () => {
    expect(finalDestination({ destination: 'https://shop.example/sale', addCampaignTags: true }, 'Summer Sale')).toBe(
      'https://shop.example/sale?utm_source=whatsapp&utm_medium=message&utm_campaign=Summer%20Sale',
    );
    expect(finalDestination({ destination: 'https://shop.example/sale', addCampaignTags: false }, 'Summer Sale')).toBe('https://shop.example/sale');
  });
});

describe('LinkRateLimiter', () => {
  function fakeRedis(count: number) {
    const keys: string[] = [];
    const chain = {
      incr: (key: string) => {
        keys.push(key);
        return chain;
      },
      expire: () => chain,
      exec: async () => [
        [null, count],
        [null, 1],
      ],
    };
    return { redis: { multi: () => chain }, keys };
  }

  it('counts each client under a salted hash of its address, never the address itself', async () => {
    const { redis, keys } = fakeRedis(1);
    const limiter = new LinkRateLimiter(redis as never, 'test-salt');
    expect(await limiter.allow('203.0.113.7')).toBe(true);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('203.0.113.7');
    expect(keys[0]).toMatch(/^wbm:linkrate:[0-9a-f]{32}:\d+$/);
  });

  it('refuses a client over the limit and lets everyone through when Redis fails', async () => {
    expect(await new LinkRateLimiter(fakeRedis(LinkRateLimiter.PER_MINUTE + 1).redis as never, 'salt').allow('203.0.113.7')).toBe(false);
    const broken = { multi: () => ({ incr: () => broken.multi(), expire: () => broken.multi(), exec: async () => { throw new Error('down'); } }) };
    expect(await new LinkRateLimiter(broken as never, 'salt').allow('203.0.113.7')).toBe(true);
    expect(await new LinkRateLimiter(fakeRedis(1).redis as never, 'salt').allow(undefined)).toBe(true);
  });
});
