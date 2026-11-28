import { describe, expect, it } from 'vitest';
import { pauseReason, skipReason } from '../../../src/modules/automations/date-automation-tick.processor.js';

// Feature 010 (US5, T055): when an automation pauses and why a due contact gets no message.
const ready = { template: { status: 'APPROVED' }, number: { connectionStatus: 'CONNECTED', sendingEnabled: true } };
const contact = { name: 'Sara', phoneE164: '+971501234567', countryCode: 'AE', consentStatus: 'OPTED_IN', blockedAt: null, attributes: { birthday: '1990-07-04' } };

describe('pauseReason', () => {
  it('needs an approved template and a connected number with sending on', () => {
    expect(pauseReason(ready)).toBeNull();
    expect(pauseReason({ ...ready, template: { status: 'REJECTED' } })).toBe('TEMPLATE_NOT_APPROVED');
    expect(pauseReason({ ...ready, number: { connectionStatus: 'ERROR', sendingEnabled: true } })).toBe('NUMBER_DISCONNECTED');
    expect(pauseReason({ ...ready, number: { connectionStatus: 'CONNECTED', sendingEnabled: false } })).toBe('SENDING_OFF');
  });
});

describe('skipReason', () => {
  it('sends to reachable contacts that still hold a date', () => {
    expect(skipReason(contact, 'birthday', false)).toBeNull();
    expect(skipReason({ ...contact, consentStatus: 'UNKNOWN' }, 'birthday', false)).toBeNull();
  });

  it('names the reason in order: blocked, opted out, invalid, no date, not opted in', () => {
    expect(skipReason({ ...contact, blockedAt: new Date(), consentStatus: 'OPTED_OUT' }, 'birthday', false)).toBe('blocked');
    expect(skipReason({ ...contact, consentStatus: 'OPTED_OUT' }, 'birthday', false)).toBe('opted_out');
    expect(skipReason({ ...contact, phoneE164: '+97112' }, 'birthday', false)).toBe('invalid');
    expect(skipReason({ ...contact, attributes: {} }, 'birthday', false)).toBe('no_date');
    expect(skipReason({ ...contact, attributes: { birthday: 'soon' } }, 'birthday', false)).toBe('no_date');
    expect(skipReason({ ...contact, consentStatus: 'UNKNOWN' }, 'birthday', true)).toBe('not_opted_in');
  });
});
