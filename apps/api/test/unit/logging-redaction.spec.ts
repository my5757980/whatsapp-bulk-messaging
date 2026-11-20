import { describe, expect, it } from 'vitest';
import { sanitizeLogObject } from '../../src/common/logging/redaction.js';

// T100: live chat content and push subscriptions never reach the logs (constitution Principle VI).
describe('sanitizeLogObject: live chat (feature 002)', () => {
  it('removes chat text, captions, notes, previews and automatic message content', () => {
    const out = sanitizeLogObject({
      item: { kind: 'NOTE', text: 'Customer is upset, call back', payload: { mentions: ['u1'] } },
      image: { caption: 'Here is my ID card', link: 'https://example.test/x.jpg' },
      note: 'internal remark',
      lastMessagePreview: 'Photo: my passport',
      preview: 'Hello there',
      template: { renderedText: 'Hi Sara, your order 123 is ready' },
      settings: { welcomeContent: { kind: 'TEXT', text: 'Welcome!' }, offHoursContent: { kind: 'TEXT', text: 'Closed' } },
    }) as Record<string, Record<string, unknown> | string>;
    expect((out.item as Record<string, unknown>).text).toBe('[REDACTED]');
    expect((out.item as Record<string, unknown>).payload).toEqual({ mentions: ['u1'] });
    expect((out.image as Record<string, unknown>).caption).toBe('[REDACTED]');
    expect(out.note).toBe('[REDACTED]');
    expect(out.lastMessagePreview).toBe('[REDACTED]');
    expect(out.preview).toBe('[REDACTED]');
    expect((out.template as Record<string, unknown>).renderedText).toBe('[REDACTED]');
    expect(out.settings).toEqual({ welcomeContent: '[REDACTED]', offHoursContent: '[REDACTED]' });
  });

  it('removes push subscription endpoints and keys', () => {
    const out = sanitizeLogObject({
      device: { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BNc...', auth: 'tBH...' } },
      p256dh: 'BNc...',
      auth: 'tBH...',
    }) as Record<string, unknown>;
    expect(out.device).toEqual({ endpoint: '[REDACTED]', keys: '[REDACTED]' });
    expect(out.p256dh).toBe('[REDACTED]');
    expect(out.auth).toBe('[REDACTED]');
  });
});
