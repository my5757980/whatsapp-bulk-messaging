import { describe, expect, it } from 'vitest';
import { sanitizeLogObject } from '../../src/common/logging/redaction.js';

describe('sanitizeLogObject (constitution Principle VI)', () => {
  it('redacts secrets and auth material', () => {
    const out = sanitizeLogObject({
      authorization: 'Bearer wbk_abc',
      headers: { cookie: 'sid=1', 'x-ops-token': 'ops', 'x-csrf-token': 'c' },
      accessToken: 'EAAG...',
      password: 'hunter2',
      apiKey: 'wbk_x',
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.accessToken).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.headers).toEqual({ cookie: '[REDACTED]', 'x-ops-token': '[REDACTED]', 'x-csrf-token': '[REDACTED]' });
  });

  it('removes message text and template parameter values', () => {
    const out = sanitizeLogObject({ text: 'Your OTP is 1234', resolvedParams: { 'BODY.1': 'Sara' } }) as Record<string, unknown>;
    expect(out.text).toBe('[REDACTED]');
    expect(out.resolvedParams).toBe('[REDACTED]');
  });

  it('masks phone fields to the last 4 digits, including nested values and arrays', () => {
    const out = sanitizeLogObject({
      phone: '+971501234567',
      message: { to: '971501234567', recipient_id: '971509876543' },
      contacts: [{ wa_id: '923001234567' }, { phone_e164: '+16502530000' }],
      from: '971500000001',
    }) as Record<string, unknown>;
    expect(out.phone).toBe('•••• 4567');
    expect(out.message).toEqual({ to: '•••• 4567', recipient_id: '•••• 6543' });
    expect(out.contacts).toEqual([{ wa_id: '•••• 4567' }, { phone_e164: '•••• 0000' }]);
    expect(out.from).toBe('•••• 0001');
  });

  it('leaves other fields and the original object untouched', () => {
    const input = { campaignId: 'c1', messageId: 'm1', phone: '+971501234567', count: 3 };
    const out = sanitizeLogObject(input) as Record<string, unknown>;
    expect(out).toMatchObject({ campaignId: 'c1', messageId: 'm1', count: 3 });
    expect(input.phone).toBe('+971501234567');
  });
});
