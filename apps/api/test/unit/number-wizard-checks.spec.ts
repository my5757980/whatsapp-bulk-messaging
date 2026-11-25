import { describe, expect, it } from 'vitest';
import type { TokenDebugInfo, WizardPhoneNumber } from '../../src/modules/meta/meta-graph.client.js';
import { appChecks, isReady, numberChecks, testMessageCheck, tokenChecks, wabaIdsFrom, worstOf } from '../../src/modules/integrations/number-wizard/wizard-checks.js';

// T077 (feature 006 US8, research R13): the wizard's check rules built from Graph answers.
const NOW = new Date('2026-11-25T10:00:00Z');
const token = (over: Partial<TokenDebugInfo> = {}): TokenDebugInfo => ({
  isValid: true,
  appId: '1234567890',
  type: 'SYSTEM_USER',
  expiresAt: 0,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'],
  granularScopes: [
    { scope: 'whatsapp_business_management', targetIds: ['WABA1', 'WABA2'] },
    { scope: 'whatsapp_business_messaging', targetIds: ['WABA1'] },
  ],
  error: null,
  ...over,
});
const phone = (over: Partial<WizardPhoneNumber> = {}): WizardPhoneNumber => ({
  id: '111',
  displayPhoneNumber: '+971 50 123 4567',
  verifiedName: 'Acme',
  nameStatus: 'APPROVED',
  status: 'CONNECTED',
  codeVerificationStatus: 'VERIFIED',
  qualityRating: 'GREEN',
  platformType: 'CLOUD_API',
  throughputLevel: 'STANDARD',
  messagingLimit: 'TIER_1K',
  ...over,
});
const byName = (checks: ReturnType<typeof tokenChecks>) => Object.fromEntries(checks.map((c) => [c.check, c]));

describe('number wizard checks', () => {
  it('names missing permissions and treats expires_at 0 as never expiring', () => {
    const good = byName(tokenChecks(token(), NOW));
    expect(good).toMatchObject({ TOKEN_VALID: { result: 'PASSED' }, TOKEN_PERMISSIONS: { result: 'PASSED' }, TOKEN_EXPIRY: { result: 'PASSED', detail: 'The token never expires.' } });
    const missing = byName(tokenChecks(token({ scopes: ['whatsapp_business_management'] }), NOW));
    expect(missing.TOKEN_PERMISSIONS).toMatchObject({ result: 'FAILED', detail: 'The token is missing the permission whatsapp_business_messaging.' });
    expect(missing.TOKEN_PERMISSIONS!.fix).toContain('System users');
    const expiring = byName(tokenChecks(token({ expiresAt: Math.floor(NOW.getTime() / 1000) + 3 * 86_400 }), NOW));
    expect(expiring.TOKEN_EXPIRY).toMatchObject({ result: 'WARNING', detail: 'The token expires on 2026-11-28; sending stops then.' });
    const expired = byName(tokenChecks(token({ expiresAt: Math.floor(NOW.getTime() / 1000) - 60 }), NOW));
    expect(expired.TOKEN_EXPIRY!.result).toBe('FAILED');
    const invalid = tokenChecks(token({ isValid: false, error: 'Session has expired' }), NOW);
    expect(invalid).toEqual([expect.objectContaining({ check: 'TOKEN_VALID', result: 'FAILED', detail: 'Meta does not accept this token: Session has expired.' })]);
    expect(worstOf(tokenChecks(token({ scopes: [] }), NOW)).check).toBe('TOKEN_PERMISSIONS');
    expect(wabaIdsFrom(token())).toEqual(['WABA1', 'WABA2']);
  });

  it('reads NOT_APPLICABLE as not registered, with the register fix', () => {
    const checks = byName(numberChecks(phone({ platformType: 'NOT_APPLICABLE' })));
    expect(checks.NUMBER_REGISTERED).toMatchObject({ result: 'FAILED', fixAction: 'REGISTER_NUMBER' });
    expect(checks.TWO_STEP_PIN!.result).toBe('WARNING');
    expect(byName(numberChecks(phone())).NUMBER_REGISTERED!.result).toBe('PASSED');
    expect(byName(numberChecks(phone({ codeVerificationStatus: 'NOT_VERIFIED', platformType: 'NOT_APPLICABLE' }))).NUMBER_REGISTERED).toMatchObject({ result: 'FAILED', fixAction: null });
  });

  it('checks the display name, quality and messaging limit', () => {
    expect(byName(numberChecks(phone({ nameStatus: 'DECLINED' }))).DISPLAY_NAME).toMatchObject({ result: 'FAILED', detail: '"Acme" was declined.' });
    expect(byName(numberChecks(phone({ nameStatus: 'PENDING_REVIEW' }))).DISPLAY_NAME!.result).toBe('WARNING');
    expect(byName(numberChecks(phone({ qualityRating: 'YELLOW' }))).QUALITY!.result).toBe('WARNING');
    expect(byName(numberChecks(phone({ qualityRating: 'UNKNOWN' }))).QUALITY!.result).toBe('PASSED');
    expect(byName(numberChecks(phone({ messagingLimit: 'TIER_250' }))).MESSAGING_LIMIT).toMatchObject({ result: 'WARNING', detail: 'New customers a day: 250.' });
    expect(byName(numberChecks(phone())).MESSAGING_LIMIT).toMatchObject({ result: 'PASSED', detail: 'New customers a day: 1,000.' });
    expect(byName(numberChecks(phone({ messagingLimit: null }))).MESSAGING_LIMIT!.result).toBe('WARNING');
  });

  it('needs the company app among the subscribed apps, and the right callback URL', () => {
    const expectedCallback = 'https://wbm.example.test/api/webhooks/meta';
    const subscriptions = [{ object: 'whatsapp_business_account', callbackUrl: expectedCallback, active: true, fields: ['messages'] }];
    const ok = byName(appChecks({ appId: '1234567890', subscribedApps: [{ id: '1234567890', name: 'Company app' }], subscriptions, expectedCallback }));
    expect(ok).toMatchObject({ APP_SUBSCRIBED: { result: 'PASSED' }, WEBHOOK_CALLBACK: { result: 'PASSED' } });
    const other = byName(appChecks({ appId: '1234567890', subscribedApps: [{ id: '999', name: 'Another app' }], subscriptions, expectedCallback }));
    expect(other.APP_SUBSCRIBED).toMatchObject({ result: 'FAILED', fixAction: 'SUBSCRIBE_APP' });
    const wrong = byName(appChecks({ appId: '1234567890', subscribedApps: [], subscriptions: [{ ...subscriptions[0]!, callbackUrl: 'https://old.example/hook' }], expectedCallback }));
    expect(wrong.WEBHOOK_CALLBACK).toMatchObject({ result: 'FAILED', detail: 'The app sends webhooks to https://old.example/hook.' });
    expect(wrong.WEBHOOK_CALLBACK!.fix).toContain(expectedCallback);
    const noApp = byName(appChecks({ appId: null, subscribedApps: [{ id: '5', name: 'Some app' }], subscriptions: null, expectedCallback }));
    expect(noApp).toMatchObject({ APP_SUBSCRIBED: { result: 'PASSED' }, WEBHOOK_CALLBACK: { result: 'WARNING' } });
  });

  it('gives a plain fix for every failure, and is ready only without failures', () => {
    const all = [
      ...tokenChecks(token({ scopes: [], expiresAt: 1 }), NOW),
      ...numberChecks(phone({ platformType: 'NOT_APPLICABLE', nameStatus: 'DECLINED' })),
      ...appChecks({ appId: '1', subscribedApps: [], subscriptions: [], expectedCallback: 'https://x/api/webhooks/meta' }),
      testMessageCheck({ sent: true, delivered: false, error: null }),
    ];
    for (const check of all.filter((c) => c.result === 'FAILED')) expect(check.fix, check.check).toMatch(/\w{3,}/);
    expect(isReady(all)).toBe(false);
    expect(isReady([...tokenChecks(token(), NOW), ...numberChecks(phone())])).toBe(true);
    expect(testMessageCheck({ sent: true, delivered: true, error: null }).result).toBe('PASSED');
  });
});
