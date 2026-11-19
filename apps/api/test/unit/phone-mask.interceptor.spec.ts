import { describe, expect, it } from 'vitest';
import { maskPhoneFields } from '../../src/common/interceptors/phone-mask.interceptor.js';

const keys = new Set(['phone', 'phoneE164']);

describe('maskPhoneFields (FR-007, T048)', () => {
  it('masks phone keys in nested objects and arrays', () => {
    const body = {
      items: [
        { id: 'c1', phone: '+971501234567', name: 'Sara' },
        { id: 'c2', phone: '+923001234567', contact: { phoneE164: '+16502530000' } },
      ],
      page: { page: 1, total: 2 },
    };
    expect(maskPhoneFields(body, keys)).toEqual({
      items: [
        { id: 'c1', phone: '•••• 4567', name: 'Sara' },
        { id: 'c2', phone: '•••• 4567', contact: { phoneE164: '•••• 0000' } },
      ],
      page: { page: 1, total: 2 },
    });
  });

  it('keeps null phones (deleted contacts) as null', () => {
    expect(maskPhoneFields({ phone: null }, keys)).toEqual({ phone: null });
  });

  it('does not touch dates or primitive bodies', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(maskPhoneFields({ sentAt: date }, keys)).toEqual({ sentAt: date });
    expect(maskPhoneFields('ok', keys)).toBe('ok');
    expect(maskPhoneFields(undefined, keys)).toBeUndefined();
  });
});
