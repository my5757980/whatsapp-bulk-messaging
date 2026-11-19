import { describe, expect, it } from 'vitest';
import { bodyPlaceholders, validateTemplate, type TemplateDraft } from './template-rules.js';

// T132: template rules shared by the editor and the API (FR-018).
const valid: TemplateDraft = {
  name: 'summer_offer_2026',
  language: 'en_US',
  category: 'MARKETING',
  header: { format: 'TEXT', text: 'Hello {{1}}', textExample: 'Sara' },
  body: { text: 'Hi {{1}}, enjoy {{2}} off this week.', examples: ['Sara', '20%'] },
  footer: 'Reply STOP to unsubscribe',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Stop promotions' },
    { type: 'URL', text: 'Shop now', url: 'https://shop.example.com/offers/{{1}}', urlExample: 'summer' },
    { type: 'PHONE_NUMBER', text: 'Call us', phoneNumber: '+15550100000' },
  ],
};
const fields = (draft: Partial<TemplateDraft>, media?: { mimeType: string; sizeBytes: number } | null) =>
  validateTemplate({ ...valid, ...draft }, media).map((i) => i.field);

describe('validateTemplate', () => {
  it('accepts a complete marketing template', () => {
    expect(validateTemplate(valid)).toEqual([]);
  });

  it('checks the name and language format', () => {
    expect(fields({ name: 'Summer Offer' })).toEqual(['name']);
    expect(fields({ name: '' })).toEqual(['name']);
    expect(fields({ name: 'a'.repeat(513) })).toEqual(['name']);
    expect(fields({ language: 'english' })).toEqual(['language']);
  });

  it('limits body, header and footer length', () => {
    expect(fields({ body: { text: 'x'.repeat(1025), examples: [] } })).toEqual(['body.text']);
    expect(fields({ body: { text: '', examples: [] } })).toEqual(['body.text']);
    expect(fields({ header: { format: 'TEXT', text: 'h'.repeat(61) } })).toEqual(['header.text']);
    expect(fields({ footer: 'f'.repeat(61) })).toEqual(['footer']);
    expect(fields({ footer: 'Code {{1}}' })).toEqual(['footer']);
  });

  it('needs sequential numbered placeholders with sample values', () => {
    expect(fields({ body: { text: 'Hi {{1}} and {{3}}', examples: ['a', 'b', 'c'] } })).toEqual(['body.text']);
    expect(fields({ body: { text: 'Hi {{name}}', examples: ['a'] } })).toEqual(['body.text']);
    expect(fields({ body: { text: 'Hi {{1}}, code {{2}}', examples: ['Sara'] } })).toEqual(['body.examples.1']);
    expect(fields({ body: { text: 'Hi {{1}}', examples: ['  '] } })).toEqual(['body.examples.0']);
    expect(fields({ header: { format: 'TEXT', text: 'Hi {{1}} {{2}}', textExample: 'a' } })).toEqual(['header.text']);
    expect(fields({ header: { format: 'TEXT', text: 'Hi {{1}}' } })).toEqual(['header.textExample']);
  });

  it('limits buttons: at most 10, 2 website links and 1 phone number', () => {
    const quick = Array.from({ length: 11 }, (_, i) => ({ type: 'QUICK_REPLY' as const, text: `Option ${i}` }));
    expect(fields({ buttons: quick })).toEqual(['buttons']);
    const urls = Array.from({ length: 3 }, (_, i) => ({ type: 'URL' as const, text: `Link ${i}`, url: 'https://example.com' }));
    expect(fields({ buttons: urls })).toEqual(['buttons']);
    expect(
      fields({
        buttons: [
          { type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '+15550100000' },
          { type: 'PHONE_NUMBER', text: 'Call 2', phoneNumber: '+15550100001' },
        ],
      }),
    ).toEqual(['buttons']);
  });

  it('checks each button', () => {
    expect(fields({ buttons: [{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }] })).toEqual(['buttons.0.text']);
    expect(fields({ buttons: [{ type: 'URL', text: 'Go', url: 'ftp://example.com' }] })).toEqual(['buttons.0.url']);
    expect(fields({ buttons: [{ type: 'URL', text: 'Go', url: 'https://example.com/{{1}}/x' }] })).toEqual(['buttons.0.url']);
    expect(fields({ buttons: [{ type: 'URL', text: 'Go', url: 'https://example.com/{{1}}' }] })).toEqual(['buttons.0.urlExample']);
    expect(fields({ buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phoneNumber: '0501234567' }] })).toEqual(['buttons.0.phoneNumber']);
  });

  it('checks header media type and size', () => {
    const image = { format: 'IMAGE' as const, mediaAssetId: '0190a000-0000-7000-8000-000000000001' };
    expect(fields({ header: { format: 'IMAGE' } })).toEqual(['header.mediaAssetId']);
    expect(fields({ header: image }, { mimeType: 'image/png', sizeBytes: 1024 })).toEqual([]);
    expect(fields({ header: image }, { mimeType: 'application/pdf', sizeBytes: 1024 })).toEqual(['header.mediaAssetId']);
    expect(fields({ header: image }, { mimeType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 })).toEqual(['header.mediaAssetId']);
    expect(fields({ header: { format: 'VIDEO', mediaAssetId: image.mediaAssetId } }, { mimeType: 'video/mp4', sizeBytes: 10 * 1024 * 1024 })).toEqual([]);
  });

  it('points authentication templates to their fixed format', () => {
    expect(fields({ category: 'AUTHENTICATION' })).toEqual(['category']);
  });

  it('returns readable issues', () => {
    const [issue] = validateTemplate({ ...valid, name: 'Bad Name' });
    expect(issue?.issue).toMatch(/lower-case letters, numbers and underscores/);
  });
});

describe('bodyPlaceholders', () => {
  it('lists the distinct placeholder numbers in order', () => {
    expect(bodyPlaceholders('Hi {{1}}, {{2}} and {{1}} again')).toEqual(['1', '2']);
  });
});
