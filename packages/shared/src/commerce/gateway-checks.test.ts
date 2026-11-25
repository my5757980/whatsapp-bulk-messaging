import { describe, expect, it } from 'vitest';
import { gatewayChecks, gatewayReady, keyInfo, type GatewayFacts } from './gateway-checks.js';

// T010 (feature 008, research R4): the Stripe connection checks, each with a plain fix.
const ok: GatewayFacts = {
  key: 'rk_test_mockOK1234',
  account: { ok: true, name: 'Mock Store LLC', country: 'AE', currency: 'aed', chargesEnabled: true, detailsSubmitted: true, currentlyDue: [] },
  checkout: { ok: true },
  webhook: { mode: 'auto', ok: true },
};
const find = (facts: GatewayFacts, check: string) => gatewayChecks(facts).find((c) => c.check === check);

describe('keyInfo', () => {
  it('reads the kind and mode from the key prefix', () => {
    expect(keyInfo('rk_test_mockOK1234')).toEqual({ valid: true, kind: 'restricted', mode: 'TEST' });
    expect(keyInfo('sk_live_abcdefghij12')).toEqual({ valid: true, kind: 'secret', mode: 'LIVE' });
    expect(keyInfo('pk_live_abcdefghij12')).toEqual({ valid: false, kind: null, mode: null });
    expect(keyInfo('rk_test_short')).toEqual({ valid: false, kind: null, mode: null });
  });
});

describe('gatewayChecks', () => {
  it('passes a restricted key on a UAE account in AED with charges enabled', () => {
    const checks = gatewayChecks(ok);
    expect(checks.map((c) => c.check)).toEqual(['KEY_FORMAT', 'KEY_KIND', 'ACCOUNT_READ', 'ACCOUNT_COUNTRY', 'ACCOUNT_CURRENCY', 'CHARGES_ENABLED', 'CHECKOUT_ACCESS', 'WEBHOOK_ENDPOINT']);
    expect(checks.every((c) => c.result === 'PASSED')).toBe(true);
    expect(find(ok, 'ACCOUNT_READ')?.detail).toContain('Mock Store LLC');
    expect(gatewayReady(checks)).toBe(true);
  });

  it('warns about a secret key and recommends a restricted one', () => {
    const check = find({ ...ok, key: 'sk_test_abcdefghij12' }, 'KEY_KIND');
    expect(check?.result).toBe('WARNING');
    expect(check?.fix).toMatch(/restricted key/i);
  });

  it('warns for another country or currency, and fails when Stripe cannot take payments yet', () => {
    const elsewhere: GatewayFacts = { ...ok, account: { ...(ok.account as Extract<GatewayFacts['account'], { ok: true }>), country: 'GB', currency: 'gbp' } };
    expect(find(elsewhere, 'ACCOUNT_COUNTRY')?.result).toBe('WARNING');
    expect(find(elsewhere, 'ACCOUNT_CURRENCY')?.detail).toContain('GBP');
    const blocked: GatewayFacts = { ...ok, account: { ...(ok.account as Extract<GatewayFacts['account'], { ok: true }>), chargesEnabled: false, currentlyDue: ['external_account', 'business_profile.url'] } };
    const charges = find(blocked, 'CHARGES_ENABLED');
    expect(charges?.result).toBe('FAILED');
    expect(charges?.detail).toContain('external_account');
    expect(gatewayReady(gatewayChecks(blocked))).toBe(false);
  });

  it('only warns when a restricted key may not read the account, and skips the account checks', () => {
    const facts: GatewayFacts = { ...ok, account: { ok: false, status: 403, message: 'permission' } };
    const checks = gatewayChecks(facts);
    expect(checks.find((c) => c.check === 'ACCOUNT_READ')?.result).toBe('WARNING');
    expect(checks.some((c) => c.check === 'CHARGES_ENABLED')).toBe(false);
    expect(gatewayReady(checks)).toBe(true);
  });

  it('fails when Checkout Sessions may not be created, naming the permission', () => {
    const check = find({ ...ok, checkout: { ok: false, status: 403, message: 'no' } }, 'CHECKOUT_ACCESS');
    expect(check?.result).toBe('FAILED');
    expect(check?.fix).toMatch(/Checkout Sessions/);
  });

  it('fails a refused endpoint registration with the manual fix, and a manual setup without its secret', () => {
    const refused = find({ ...ok, webhook: { mode: 'auto', ok: false, status: 403, message: 'no' } }, 'WEBHOOK_ENDPOINT');
    expect(refused?.result).toBe('FAILED');
    expect(refused?.fix).toMatch(/signing secret/);
    expect(find({ ...ok, webhook: { mode: 'manual', secretGiven: true } }, 'WEBHOOK_ENDPOINT')?.result).toBe('PASSED');
    expect(find({ ...ok, webhook: { mode: 'manual', secretGiven: false } }, 'WEBHOOK_ENDPOINT')?.result).toBe('FAILED');
  });

  it('fails a malformed key before anything else', () => {
    const checks = gatewayChecks({ ...ok, key: 'not-a-key' });
    expect(checks[0]).toMatchObject({ check: 'KEY_FORMAT', result: 'FAILED' });
    expect(gatewayReady(checks)).toBe(false);
  });
});
