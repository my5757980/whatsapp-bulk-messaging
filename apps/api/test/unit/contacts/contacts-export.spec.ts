import { describe, expect, it } from 'vitest';
import { contactCsvLine } from '../../../src/modules/contacts/contacts-export.controller.js';

// T033 (feature 010 US2, research R6): one export line, with phones masked for roles without phones.full.
const row = {
  id: 'c1',
  name: 'Sara, "VIP"',
  phone_e164: '+971501234567',
  attributes: { city: 'Dubai', orders: 3, prefs: { lang: 'ar' } },
  consent_status: 'OPTED_IN',
  consent_source: 'KEYWORD',
  consent_at: new Date('2026-11-01T10:00:00Z'),
  lead_source_kind: 'IMPORT' as const,
  lead_source: 'Expo leads',
  created_at: new Date('2026-10-01T08:00:00Z'),
  tags: ['vip', 'customer'],
  last_message_at: null,
};

describe('contactCsvLine', () => {
  it('writes every column, quoting values that need it', () => {
    expect(contactCsvLine(row, ['city', 'orders', 'prefs', 'birthday'], true)).toBe(
      '"Sara, ""VIP""",+971501234567,customer;vip,Dubai,3,"{""lang"":""ar""}",,OPTED_IN,KEYWORD,2026-11-01T10:00:00.000Z,IMPORT,Expo leads,2026-10-01T08:00:00.000Z,\n',
    );
  });

  it('masks the phone when the role does not see full phones', () => {
    const line = contactCsvLine(row, [], false);
    expect(line).not.toContain('+971501234567');
    expect(line).toContain(',•••• 4567,');
  });
});
