import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStripeSignature, signStripePayload, verifyStripeSignature, type HmacHex } from './stripe-signature.js';

// T009 (feature 008, research R3, contracts/stripe.md): Stripe-Signature checked by hand.
const hmacHex: HmacHex = (secret, content) => createHmac('sha256', secret).update(content).digest('hex');
const SECRET = 'whsec_test_secret_0001';
const OLD = 'whsec_test_secret_0000';
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
const T = 1_795_000_000;

describe('parseStripeSignature', () => {
  it('reads t and every v1, ignoring v0, unknown keys and spaces', () => {
    expect(parseStripeSignature(`t=${T}, v1=aaa,v1=bbb ,v0=ccc,payload=xyz`)).toEqual({ timestamp: T, signatures: ['aaa', 'bbb'] });
    expect(parseStripeSignature('v1=aaa')).toEqual({ timestamp: null, signatures: ['aaa'] });
    expect(parseStripeSignature('')).toEqual({ timestamp: null, signatures: [] });
    expect(parseStripeSignature('t=abc,v1=x')).toEqual({ timestamp: null, signatures: ['x'] });
  });
});

describe('verifyStripeSignature', () => {
  const header = (secret = SECRET, t = T, body = BODY) => signStripePayload(secret, t, body, hmacHex);
  const verify = (h: string | undefined, overrides: Partial<Parameters<typeof verifyStripeSignature>[0]> = {}) =>
    verifyStripeSignature({ rawBody: BODY, header: h, secrets: [SECRET], nowSeconds: T, hmacHex, ...overrides });

  it('accepts the HMAC-SHA256 of "t.body" with the endpoint secret', () => {
    expect(header()).toBe(`t=${T},v1=${hmacHex(SECRET, `${T}.${BODY}`)}`);
    expect(verify(header())).toEqual({ ok: true });
  });

  it('accepts any of several v1 signatures (a secret roll) and the previous secret while it is valid', () => {
    const both = `t=${T},v1=${hmacHex(OLD, `${T}.${BODY}`)},v1=${hmacHex(SECRET, `${T}.${BODY}`)}`;
    expect(verify(both)).toEqual({ ok: true });
    expect(verify(header(OLD), { secrets: [SECRET, OLD] })).toEqual({ ok: true });
    expect(verify(header(OLD))).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('allows 300 seconds of clock difference in both directions', () => {
    expect(verify(header(), { nowSeconds: T + 300 })).toEqual({ ok: true });
    expect(verify(header(), { nowSeconds: T - 300 })).toEqual({ ok: true });
    expect(verify(header(), { nowSeconds: T + 301 })).toEqual({ ok: false, reason: 'TIMESTAMP' });
    expect(verify(header(), { nowSeconds: T - 301 })).toEqual({ ok: false, reason: 'TIMESTAMP' });
  });

  it('refuses missing parts, a changed body and a forged timestamp', () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify(`v1=${hmacHex(SECRET, `${T}.${BODY}`)}`)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify(`t=${T}`)).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verify(header(), { rawBody: `${BODY} ` })).toEqual({ ok: false, reason: 'MISMATCH' });
    const forged = header().replace(`t=${T}`, `t=${T + 10}`);
    expect(verify(forged)).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify(header(), { secrets: [] })).toEqual({ ok: false, reason: 'MISMATCH' });
  });
});
