import { describe, expect, it } from 'vitest';
import { bodyPlaceholders, payLinkButtonIndex, ttlAfterCategoryChange, ttlAppliedByFor, ttlFits, validateTemplate, type CarouselCardDraft, type TemplateDraft } from './template-rules.js';

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

  it('points authentication templates to the one-time code type', () => {
    expect(fields({ category: 'AUTHENTICATION' })).toEqual(['category']);
  });

  it('returns readable issues', () => {
    const [issue] = validateTemplate({ ...valid, name: 'Bad Name' });
    expect(issue?.issue).toMatch(/lower-case letters, numbers and underscores/);
  });
});

// T014 (feature 008, contracts/meta-commerce-graph.md): catalog, product list and form buttons.
describe('commerce buttons', () => {
  const body = { text: 'See what is new this week.' };
  it('allows a catalog or product list button as the only button of a marketing template', () => {
    expect(validateTemplate({ ...valid, header: null, body, buttons: [{ type: 'CATALOG', text: 'View catalog' }] })).toEqual([]);
    expect(validateTemplate({ ...valid, header: { format: 'TEXT', text: 'New in' }, body, buttons: [{ type: 'MPM', text: 'View items' }] })).toEqual([]);
  });

  it('refuses them beside other buttons or in a utility template', () => {
    expect(fields({ header: null, body, buttons: [{ type: 'CATALOG', text: 'View catalog' }, { type: 'QUICK_REPLY', text: 'Stop' }] })).toContain('buttons.0.type');
    expect(fields({ header: null, body, category: 'UTILITY', buttons: [{ type: 'MPM', text: 'View items' }] })).toContain('category');
  });

  it('needs a published form for a FLOW button, with the usual text limit', () => {
    expect(validateTemplate({ ...valid, category: 'UTILITY', header: null, body, buttons: [{ type: 'FLOW', text: 'Book now', flowId: 'MOCKFLOW1764000000000001' }] })).toEqual([]);
    expect(fields({ header: null, body, buttons: [{ type: 'FLOW', text: 'Book now' }] })).toContain('buttons.0.flowId');
    expect(fields({ header: null, body, buttons: [{ type: 'FLOW', text: 'x'.repeat(26), flowId: '123' }] })).toContain('buttons.0.text');
  });
});

describe('payLinkButtonIndex', () => {
  const base = 'https://go.example.com/l';
  it('finds the URL button that ends in /p/{{1}} on the pay link base', () => {
    expect(payLinkButtonIndex([{ type: 'QUICK_REPLY' }, { type: 'URL', url: 'https://go.example.com/l/p/{{1}}' }], base)).toBe(1);
    expect(payLinkButtonIndex([{ type: 'URL', url: 'https://go.example.com/l/p/{{ 1 }}' }], `${base}/`)).toBe(0);
  });

  it('refuses other links and a missing base', () => {
    expect(payLinkButtonIndex([{ type: 'URL', url: 'https://go.example.com/l/{{1}}' }], base)).toBe(-1);
    expect(payLinkButtonIndex([{ type: 'URL', url: 'https://other.example.com/l/p/{{1}}' }], base)).toBe(-1);
    expect(payLinkButtonIndex([{ type: 'URL', url: 'https://go.example.com/l/p/{{1}}' }], null)).toBe(-1);
    expect(payLinkButtonIndex(undefined, base)).toBe(-1);
  });
});

describe('bodyPlaceholders', () => {
  it('lists the distinct placeholder numbers in order', () => {
    expect(bodyPlaceholders('Hi {{1}}, {{2}} and {{1}} again')).toEqual(['1', '2']);
  });
});

// T006 (feature 009, research R2, R6 - R8): authentication, carousel and offer kinds, and the TTL.
describe('authentication templates', () => {
  const auth = (overrides: Partial<TemplateDraft> = {}): TemplateDraft => ({
    name: 'login_code',
    language: 'en_US',
    category: 'AUTHENTICATION',
    kind: 'AUTHENTICATION',
    body: { text: '' },
    auth: { securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' },
    ...overrides,
  });
  const issues = (draft: TemplateDraft) => validateTemplate(draft).map((i) => i.field);

  it('accepts copy code and one-tap with apps', () => {
    expect(issues(auth())).toEqual([]);
    expect(issues(auth({ auth: { securityNote: false, codeExpiryMinutes: null, button: 'ONE_TAP', autofillText: 'Autofill', apps: [{ packageName: 'com.example.app', signatureHash: 'K8a/AINcGX7' }] } }))).toEqual([]);
  });

  it('checks the validity, the button and the apps', () => {
    expect(issues(auth({ auth: { securityNote: true, codeExpiryMinutes: 91, button: 'COPY_CODE' } }))).toEqual(['auth.codeExpiryMinutes']);
    expect(issues(auth({ auth: { securityNote: true, codeExpiryMinutes: 0, button: 'COPY_CODE' } }))).toEqual(['auth.codeExpiryMinutes']);
    expect(issues(auth({ auth: { securityNote: true, codeExpiryMinutes: 5, button: 'COPY_CODE', buttonText: 'x'.repeat(26) } }))).toEqual(['auth.buttonText']);
    expect(issues(auth({ auth: { securityNote: true, codeExpiryMinutes: 5, button: 'ONE_TAP', apps: [] } }))).toEqual(['auth.apps']);
    const apps = (packageName: string, signatureHash: string) => auth({ auth: { securityNote: true, codeExpiryMinutes: 5, button: 'ONE_TAP', apps: [{ packageName, signatureHash }] } });
    expect(issues(apps('example', 'K8a/AINcGX7'))).toEqual(['auth.apps.0.packageName']);
    expect(issues(apps('com.1example.app', 'K8a/AINcGX7'))).toEqual(['auth.apps.0.packageName']);
    expect(issues(apps('com.example.app', 'short'))).toEqual(['auth.apps.0.signatureHash']);
    const six = Array.from({ length: 6 }, () => ({ packageName: 'com.example.app', signatureHash: 'K8a/AINcGX7' }));
    expect(issues(auth({ auth: { securityNote: true, codeExpiryMinutes: 5, button: 'ONE_TAP', apps: six } }))).toEqual(['auth.apps']);
  });

  it('refuses a header, footer, buttons and the wrong category', () => {
    expect(issues(auth({ header: { format: 'TEXT', text: 'Hi' } }))).toEqual(['header']);
    expect(issues(auth({ footer: 'Thanks' }))).toEqual(['footer']);
    expect(issues(auth({ buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }] }))).toEqual(['buttons']);
    expect(issues(auth({ category: 'UTILITY' }))).toEqual(['category']);
    expect(issues(auth({ auth: null }))).toEqual(['auth']);
  });
});

describe('carousel templates', () => {
  const card = (overrides: Partial<CarouselCardDraft> = {}): CarouselCardDraft => ({
    mediaFormat: 'IMAGE',
    sampleMediaAssetId: '0196f1f0-0000-7000-8000-000000000001',
    bodyText: 'Linen shirt, {{1}}',
    bodyExamples: ['AED 120'],
    buttons: [
      { type: 'QUICK_REPLY', text: 'Tell me more' },
      { type: 'URL', text: 'Shop', url: 'https://shop.example.com/p/{{1}}', urlExample: 'shirt-1' },
    ],
    ...overrides,
  });
  const carousel = (cards: CarouselCardDraft[], overrides: Partial<TemplateDraft> = {}): TemplateDraft => ({
    name: 'new_arrivals',
    language: 'en_US',
    category: 'MARKETING',
    kind: 'CAROUSEL',
    body: { text: 'Hi {{1}}, our new arrivals are here.', examples: ['Sara'] },
    cards,
    ...overrides,
  });
  const issues = (draft: TemplateDraft, media?: Array<{ mimeType: string; sizeBytes: number } | null>) => validateTemplate(draft, null, media).map((i) => i.field);

  it('accepts 2 to 10 cards with the same layout', () => {
    expect(issues(carousel([card(), card()]))).toEqual([]);
    expect(issues(carousel(Array.from({ length: 10 }, () => card())))).toEqual([]);
    expect(issues(carousel([card()]))).toEqual(['cards']);
    expect(issues(carousel(Array.from({ length: 11 }, () => card())))).toEqual(['cards']);
  });

  it('is marketing only, with no header, footer or message buttons', () => {
    expect(issues(carousel([card(), card()], { category: 'UTILITY' }))).toEqual(['category']);
    expect(issues(carousel([card(), card()], { header: { format: 'TEXT', text: 'Hi' } }))).toEqual(['header']);
    expect(issues(carousel([card(), card()], { footer: 'Bye' }))).toEqual(['footer']);
    expect(issues(carousel([card(), card()], { buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }] }))).toEqual(['buttons']);
  });

  it('keeps one media format, card texts on all or none, and the same buttons', () => {
    expect(issues(carousel([card(), card({ mediaFormat: 'VIDEO' })]))).toEqual(['cards.1.mediaFormat']);
    expect(issues(carousel([card(), card({ bodyText: '', bodyExamples: [] })]))).toEqual(['cards.1.bodyText']);
    expect(issues(carousel([card({ bodyText: '', bodyExamples: [] }), card({ bodyText: '', bodyExamples: [] })]))).toEqual([]);
    expect(issues(carousel([card(), card({ bodyText: 'x'.repeat(161), bodyExamples: [] })]))).toEqual(['cards.1.bodyText']);
    expect(issues(carousel([card(), card({ buttons: [{ type: 'QUICK_REPLY', text: 'Tell me more' }] })]))).toEqual(['cards.1.buttons']);
    const three = [...card().buttons, { type: 'PHONE_NUMBER' as const, text: 'Call', phoneNumber: '+15550100000' }];
    expect(issues(carousel([card({ buttons: three }), card({ buttons: three })]))).toEqual(['cards.0.buttons', 'cards.1.buttons']);
    expect(issues(carousel([card({ sampleMediaAssetId: null }), card()]))).toEqual(['cards.0.sampleMediaAssetId']);
    expect(issues(carousel([card(), card()]), [{ mimeType: 'image/gif', sizeBytes: 100 }, null])).toEqual(['cards.0.sampleMediaAssetId']);
  });
});

describe('limited-time offer templates', () => {
  const offer = (overrides: Partial<TemplateDraft> = {}): TemplateDraft => ({
    name: 'weekend_offer',
    language: 'en_US',
    category: 'MARKETING',
    kind: 'LIMITED_TIME_OFFER',
    header: { format: 'IMAGE', mediaAssetId: '0196f1f0-0000-7000-8000-000000000002' },
    body: { text: 'Hi {{1}}, 20% off everything until Sunday.', examples: ['Sara'] },
    buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/offer/{{1}}', urlExample: 'wknd' }],
    offer: { offerText: 'Weekend deal', showsEndTime: true, codeExample: 'WKND20' },
    ...overrides,
  });
  const issues = (draft: TemplateDraft) => validateTemplate(draft).map((i) => i.field);

  it('accepts an offer with an image, the offer details and one website button', () => {
    expect(issues(offer())).toEqual([]);
    expect(issues(offer({ header: null }))).toEqual([]);
  });

  it('is marketing only with no footer, limits the texts and needs one website button', () => {
    expect(issues(offer({ category: 'UTILITY' }))).toEqual(['category']);
    expect(issues(offer({ footer: 'Bye' }))).toEqual(['footer']);
    expect(issues(offer({ header: { format: 'TEXT', text: 'Hi' } }))).toEqual(['header.format']);
    expect(issues(offer({ offer: { offerText: 'x'.repeat(17), showsEndTime: true, codeExample: 'A' } }))).toEqual(['offer.offerText']);
    expect(issues(offer({ offer: { offerText: 'Deal', showsEndTime: true, codeExample: 'x'.repeat(16) } }))).toEqual(['offer.codeExample']);
    expect(issues(offer({ buttons: [] }))).toEqual(['buttons']);
    expect(issues(offer({ body: { text: `Hi {{1}} ${'x'.repeat(590)}`, examples: ['Sara Johnson'] } }))).toEqual(['body.text']);
  });
});

describe('time-to-live', () => {
  it('has a range per category and knows who applies it', () => {
    expect(ttlFits('AUTHENTICATION', 30)).toBe(true);
    expect(ttlFits('AUTHENTICATION', 901)).toBe(false);
    expect(ttlFits('UTILITY', 43_200)).toBe(true);
    expect(ttlFits('UTILITY', 29)).toBe(false);
    expect(ttlFits('MARKETING', 43_199)).toBe(false);
    expect(ttlFits('MARKETING', 2_592_000)).toBe(true);
    expect(ttlFits('MARKETING', null)).toBe(true);
    expect(ttlAppliedByFor('AUTHENTICATION')).toBe('META');
    expect(ttlAppliedByFor('UTILITY')).toBe('META');
    expect(ttlAppliedByFor('MARKETING')).toBe('PLATFORM');
  });

  it('is checked on drafts and cleared when a category change leaves it outside the range', () => {
    expect(fields({ ttlSeconds: 3600 })).toEqual(['ttlSeconds']);
    expect(fields({ ttlSeconds: 86_400 })).toEqual([]);
    expect(ttlAfterCategoryChange('MARKETING', 600)).toBeNull();
    expect(ttlAfterCategoryChange('MARKETING', 86_400)).toBe(86_400);
    expect(ttlAfterCategoryChange('UTILITY', null)).toBeNull();
  });
});
