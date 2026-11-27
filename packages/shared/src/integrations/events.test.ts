import { describe, expect, it } from 'vitest';
import { EVENT_GROUPS, EVENT_LABELS, EVENT_TYPES, OUTBOUND_API_VERSION, buildEvent, eventContact, eventMessage, eventPayload } from './events.js';

// T010 (feature 006, research R3, contracts/webhook-events.md): the event catalog and payloads.
describe('event catalog', () => {
  it('gives every type a group and a label, test.ping included', () => {
    expect(EVENT_TYPES).toContain('message.status');
    expect(EVENT_TYPES).toContain('store.cart_recovered');
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['ad.chat_started', 'ad.lead_received']));
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['payment.requested', 'payment.paid', 'payment.failed', 'payment.expired', 'payment.refunded', 'payment.cancelled', 'chat_order.received', 'chat_order.paid', 'form.submitted']));
    expect(EVENT_TYPES).toContain('test.ping');
    for (const type of EVENT_TYPES) {
      expect(EVENT_GROUPS[type]).toMatch(/^(messages|contacts|links|drips|live_chat|api_campaigns|stores|ads|payments|commerce|forms|otp|test)$/);
      expect(EVENT_LABELS[type]).toMatch(/\w/);
    }
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});

describe('payload shapes', () => {
  it('gives contacts with E.164 phones, or null for deleted ones', () => {
    expect(eventContact({ id: 'c1', phoneE164: '+971501234567', name: 'Sara Ali' })).toEqual({ id: 'c1', phone: '+971501234567', name: 'Sara Ali' });
    expect(eventContact({ id: 'c1', phoneE164: '971501234567', name: null })).toEqual({ id: 'c1', phone: '+971501234567', name: null });
    expect(eventContact(null)).toBeNull();
  });

  it('gives messages their ids, origin and owner', () => {
    expect(
      eventMessage({ id: 'm1', waMessageId: 'wamid.1', origin: 'CAMPAIGN', campaignId: 'k1', apiCampaignId: null, dripId: null, templateName: 'order_update' }),
    ).toEqual({ id: 'm1', waMessageId: 'wamid.1', origin: 'CAMPAIGN', campaignId: 'k1', apiCampaignId: null, dripId: null, templateName: 'order_update' });
  });

  it('wraps data with the id, type, time and api version', () => {
    const at = new Date('2026-11-24T10:20:00Z');
    expect(eventPayload('evt_1', 'test.ping', at, { endpointId: 'e1' })).toEqual({
      id: 'evt_1',
      type: 'test.ping',
      timestamp: '2026-11-24T10:20:00.000Z',
      api_version: OUTBOUND_API_VERSION,
      data: { endpointId: 'e1' },
    });
    expect(OUTBOUND_API_VERSION).toBe('2026-11');
  });
});

describe('buildEvent', () => {
  const received = {
    message: { id: 'm1', waMessageId: 'wamid.2', type: 'image' },
    contact: { id: 'c1', phone: '+971501234567', name: 'Sara' },
    conversationId: 'v1',
    numberId: 'n1',
    text: 'Here is my ID card',
    caption: 'front side',
    buttonPayload: 'cod1:o1:Y',
  };

  it('keeps message content for endpoints that want it', () => {
    expect(buildEvent('message.received', received, true)).toEqual(received);
  });

  it('removes text, captions and button payloads for endpoints with content off', () => {
    const data = buildEvent('message.received', received, false) as Record<string, unknown>;
    expect(data).not.toHaveProperty('text');
    expect(data).not.toHaveProperty('caption');
    expect(data).not.toHaveProperty('buttonPayload');
    expect(data.contact).toEqual(received.contact);
    // Other types are never cut.
    expect(buildEvent('contact.opted_in', { contact: received.contact, source: 'API', note: 'web form' }, false)).toEqual({
      contact: received.contact,
      source: 'API',
      note: 'web form',
    });
  });

  it('refuses data with secret fields, however deep', () => {
    expect(() => buildEvent('test.ping', { endpointId: 'e1', secret: 'whsec_x' }, true)).toThrow(/secret/);
    expect(() => buildEvent('store.notification_sent', { store: { id: 's1', accessToken: 'shpat_x' } }, true)).toThrow(/accessToken/);
    expect(() => buildEvent('contact.updated', { contact: received.contact, changed: [{ credentials: 'x' }] }, true)).toThrow(/credentials/);
  });
});
