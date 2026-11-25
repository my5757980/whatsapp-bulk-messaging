import { describe, expect, it } from 'vitest';
import { adAccountChecks, adsReady, adsTokenChecks, audienceTermsCheck, pageChecks, worstAdsCheck } from './checks.js';

// T011 (feature 007, research R2): the ads connection checks, each with a plain fix.
const NOW = new Date('2026-11-25T10:00:00Z');
const ALL = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval', 'whatsapp_business_management'];
const byName = <T extends { check: string }>(checks: T[]) => Object.fromEntries(checks.map((c) => [c.check, c]));

describe('ads connection checks', () => {
  it('names missing permissions: core ones fail, the others warn with what stops working', () => {
    expect(byName(adsTokenChecks({ isValid: true, scopes: ALL, expiresAt: 0, error: null }, NOW))).toMatchObject({
      TOKEN_VALID: { result: 'PASSED' },
      TOKEN_PERMISSIONS: { result: 'PASSED' },
      TOKEN_EXPIRY: { result: 'PASSED' },
    });
    const noLeads = byName(adsTokenChecks({ isValid: true, scopes: ALL.filter((s) => s !== 'leads_retrieval'), expiresAt: 0, error: null }, NOW));
    expect(noLeads.TOKEN_PERMISSIONS).toMatchObject({ result: 'WARNING', detail: 'The token is missing leads_retrieval (for receiving leads).' });
    expect(noLeads.TOKEN_PERMISSIONS!.fix).toContain('System users');
    const noAds = byName(adsTokenChecks({ isValid: true, scopes: ALL.filter((s) => s !== 'ads_management'), expiresAt: 0, error: null }, NOW));
    expect(noAds.TOKEN_PERMISSIONS!.result).toBe('FAILED');
    expect(adsTokenChecks({ isValid: false, scopes: [], expiresAt: null, error: 'Session has expired' }, NOW)).toEqual([
      expect.objectContaining({ check: 'TOKEN_VALID', result: 'FAILED', detail: 'Meta does not accept this token: Session has expired.' }),
    ]);
  });

  it("checks the ad account's status, payment method and currency", () => {
    expect(byName(adAccountChecks({ accountStatus: 1, disableReason: null, hasPaymentMethod: true, currency: 'AED', timezone: 'Asia/Dubai' }))).toMatchObject({
      AD_ACCOUNT_ACTIVE: { result: 'PASSED' },
      AD_ACCOUNT_PAYMENT: { result: 'PASSED' },
      AD_ACCOUNT_CURRENCY: { result: 'PASSED', detail: 'Amounts are in AED; days follow Asia/Dubai.' },
    });
    const disabled = byName(adAccountChecks({ accountStatus: 2, disableReason: 3, hasPaymentMethod: false, currency: 'AED', timezone: 'Asia/Dubai' }));
    expect(disabled.AD_ACCOUNT_ACTIVE).toMatchObject({ result: 'FAILED', detail: 'The ad account is disabled (payment risk).' });
    expect(disabled.AD_ACCOUNT_PAYMENT!.result).toBe('FAILED');
    expect(byName(adAccountChecks({ accountStatus: 9, disableReason: null, hasPaymentMethod: true, currency: 'AED', timezone: 'Asia/Dubai' })).AD_ACCOUNT_ACTIVE!.result).toBe('WARNING');
  });

  it('checks the page, its linked numbers and the terms', () => {
    const ok = byName(pageChecks({ name: 'Acme', tasks: ['ADVERTISE', 'ANALYZE'], whatsappNumbers: ['+971 50 123 4567'], leadTermsAccepted: true }));
    expect(ok).toMatchObject({ PAGE_ADS: { result: 'PASSED' }, PAGE_WHATSAPP_NUMBERS: { result: 'PASSED' }, LEAD_TERMS: { result: 'PASSED' } });
    const notLinked = byName(pageChecks({ name: 'Acme', tasks: ['ANALYZE'], whatsappNumbers: [], leadTermsAccepted: false }));
    expect(notLinked).toMatchObject({ PAGE_ADS: { result: 'FAILED' }, PAGE_WHATSAPP_NUMBERS: { result: 'WARNING' }, LEAD_TERMS: { result: 'WARNING' } });
    expect(notLinked.PAGE_WHATSAPP_NUMBERS!.fix).toContain('Linked accounts');
    expect(byName(pageChecks({ name: 'Acme', tasks: ['ADVERTISE'], whatsappNumbers: null, leadTermsAccepted: null })).PAGE_WHATSAPP_NUMBERS!.result).toBe('WARNING');
    expect(audienceTermsCheck(false).result).toBe('WARNING');
    expect(audienceTermsCheck(true).result).toBe('PASSED');
  });

  it('is ready only without failures, and shows the worst check first', () => {
    const checks = [...adsTokenChecks({ isValid: true, scopes: ALL, expiresAt: 0, error: null }, NOW), audienceTermsCheck(false)];
    expect(adsReady(checks)).toBe(true);
    expect(worstAdsCheck(checks).check).toBe('AUDIENCE_TERMS');
    expect(adsReady([...checks, ...adAccountChecks({ accountStatus: 101, disableReason: null, hasPaymentMethod: true, currency: 'AED', timezone: 'UTC' })])).toBe(false);
  });
});
