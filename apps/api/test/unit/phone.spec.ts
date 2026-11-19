import { describe, expect, it } from 'vitest';
import { e164ToWaRecipient, maskPhone, normalizePhone, waIdToE164 } from '../../src/common/phone/phone.js';

describe('normalizePhone', () => {
  it('keeps numbers already in international format', () => {
    expect(normalizePhone('+971 50 123 4567', 'US')).toEqual({ e164: '+971501234567', country: 'AE' });
  });

  it('applies the default country to national numbers', () => {
    expect(normalizePhone('050 123 4567', 'AE')).toEqual({ e164: '+971501234567', country: 'AE' });
    expect(normalizePhone('0300 1234567', 'PK')).toEqual({ e164: '+923001234567', country: 'PK' });
  });

  it('accepts the 00 international prefix and punctuation', () => {
    expect(normalizePhone('00 1 (650) 253-0000', 'AE')).toEqual({ e164: '+16502530000', country: 'US' });
  });

  it('returns null for invalid or empty input', () => {
    expect(normalizePhone('12345', 'US')).toBeNull();
    expect(normalizePhone('', 'US')).toBeNull();
    expect(normalizePhone('not a phone', 'US')).toBeNull();
  });
});

describe('WhatsApp id helpers', () => {
  it('converts between E.164 and WhatsApp recipient digits', () => {
    expect(e164ToWaRecipient('+971501234567')).toBe('971501234567');
    expect(waIdToE164('971501234567')).toBe('+971501234567');
  });
});

describe('maskPhone', () => {
  it('shows only the last 4 digits', () => {
    expect(maskPhone('+971501234567')).toBe('•••• 4567');
  });

  it('passes through empty values', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
  });
});
