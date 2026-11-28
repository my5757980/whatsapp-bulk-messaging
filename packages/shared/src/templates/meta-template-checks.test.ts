import { describe, expect, it } from 'vitest';
import { metaCreateProblem, metaKindOf, metaSendProblem, metaStoredComponents } from './meta-template-checks.js';

// Feature 009 (contracts/meta-templates.md): Meta's create and send rules for the new kinds.
const authComponents = [
  { type: 'BODY', add_security_recommendation: true },
  { type: 'FOOTER', code_expiration_minutes: 10 },
  { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
];
const card = (format = 'IMAGE', buttons = [{ type: 'QUICK_REPLY', text: 'More' }, { type: 'URL', text: 'Shop', url: 'https://s.example.com/{{1}}', example: ['a'] }]) => ({
  components: [
    { type: 'HEADER', format, example: { header_handle: ['h'] } },
    { type: 'BODY', text: 'Price {{1}}', example: { body_text: [['1']] } },
    { type: 'BUTTONS', buttons },
  ],
});
const carouselComponents = (cards = [card(), card()]) => [{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Sara']] } }, { type: 'CAROUSEL', cards }];
const offerComponents = [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h'] } },
  { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Weekend deal', has_expiration: true } },
  { type: 'BODY', text: 'Hi {{1}}, 20% off.', example: { body_text: [['Sara']] } },
  { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'WKND20' }, { type: 'URL', text: 'Shop', url: 'https://s.example.com/{{1}}', example: ['w'] }] },
];

describe('metaKindOf', () => {
  it('tells the kinds apart', () => {
    expect(metaKindOf('AUTHENTICATION', authComponents)).toBe('AUTHENTICATION');
    expect(metaKindOf('MARKETING', carouselComponents())).toBe('CAROUSEL');
    expect(metaKindOf('MARKETING', offerComponents)).toBe('LIMITED_TIME_OFFER');
    expect(metaKindOf('UTILITY', [{ type: 'BODY', text: 'x' }])).toBe('STANDARD');
  });
});

describe('metaCreateProblem', () => {
  it('accepts valid bodies of each kind', () => {
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: authComponents, message_send_ttl_seconds: 600 })).toBeNull();
    expect(metaCreateProblem({ category: 'MARKETING', components: carouselComponents() })).toBeNull();
    expect(metaCreateProblem({ category: 'MARKETING', components: offerComponents })).toBeNull();
    expect(metaCreateProblem({ category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }], message_send_ttl_seconds: 43_200 })).toBeNull();
  });

  it('refuses TTLs out of range and marketing TTLs', () => {
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: authComponents, message_send_ttl_seconds: 901 })).toMatch(/between 30 and 900/);
    expect(metaCreateProblem({ category: 'UTILITY', components: [], message_send_ttl_seconds: 43_201 })).toMatch(/between 30 and 43200/);
    expect(metaCreateProblem({ category: 'MARKETING', components: [], message_send_ttl_seconds: 86_400 })).toMatch(/Marketing Messages API/);
  });

  it('checks authentication bodies', () => {
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: [{ type: 'BODY', text: 'Your code {{1}}' }, authComponents[2]] })).toMatch(/set by WhatsApp/);
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: [authComponents[0], { type: 'FOOTER', code_expiration_minutes: 91 }, authComponents[2]] })).toMatch(/1 and 90/);
    const oneTap = (apps: unknown[]) => [authComponents[0], { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'ONE_TAP', supported_apps: apps }] }];
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: oneTap([{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }]) })).toBeNull();
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: oneTap([]) })).toMatch(/1 to 5/);
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components: oneTap([{ package_name: 'com.example.app', signature_hash: 'short' }]) })).toMatch(/11 characters/);
  });

  it('checks carousels', () => {
    expect(metaCreateProblem({ category: 'UTILITY', components: carouselComponents() })).toMatch(/MARKETING/);
    expect(metaCreateProblem({ category: 'MARKETING', components: carouselComponents([card()]) })).toMatch(/2 to 10/);
    expect(metaCreateProblem({ category: 'MARKETING', components: carouselComponents([card(), card('VIDEO')]) })).toMatch(/same components/);
    expect(metaCreateProblem({ category: 'MARKETING', components: carouselComponents([card(), card('IMAGE', [{ type: 'QUICK_REPLY', text: 'More' }])]) })).toMatch(/same components/);
  });

  it('checks offers', () => {
    expect(metaCreateProblem({ category: 'MARKETING', components: [...offerComponents, { type: 'FOOTER', text: 'x' }] })).toMatch(/Footer/);
    const longHeading = offerComponents.map((c) => (c.type === 'LIMITED_TIME_OFFER' ? { ...c, limited_time_offer: { text: 'x'.repeat(17), has_expiration: true } } : c));
    expect(metaCreateProblem({ category: 'MARKETING', components: longHeading })).toMatch(/16 characters/);
  });
});

describe('metaStoredComponents', () => {
  it('turns authentication OTP buttons into URL buttons, as Meta stores them', () => {
    const stored = metaStoredComponents('AUTHENTICATION', authComponents) as Array<{ type: string; buttons?: Array<{ type: string }> }>;
    expect(stored.find((c) => c.type === 'BUTTONS')?.buttons?.[0]?.type).toBe('URL');
  });
});

describe('metaSendProblem', () => {
  it('needs the code twice for authentication templates', () => {
    const template = { category: 'AUTHENTICATION', components: authComponents };
    const send = (bodyCode: string, buttonCode: string) => [
      { type: 'BODY', parameters: [{ type: 'text', text: bodyCode }] },
      { type: 'BUTTON', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonCode }] },
    ];
    expect(metaSendProblem(template, send('482913', '482913'))).toBeNull();
    expect(metaSendProblem(template, send('482913', '000000'))).toMatch(/appear in the body and in the button/);
    expect(metaSendProblem(template, send('x'.repeat(16), 'x'.repeat(16)))).toMatch(/1 to 15/);
  });

  it('needs every carousel card with a media id', () => {
    const template = { category: 'MARKETING', components: carouselComponents() };
    const cardSend = (i: number, media: object) => ({ card_index: i, components: [{ type: 'HEADER', parameters: [{ type: 'image', image: media }] }] });
    expect(metaSendProblem(template, [{ type: 'CAROUSEL', cards: [cardSend(0, { id: 'm1' }), cardSend(1, { id: 'm2' })] }])).toBeNull();
    expect(metaSendProblem(template, [{ type: 'CAROUSEL', cards: [cardSend(0, { id: 'm1' })] }])).toMatch(/2 cards/);
    expect(metaSendProblem(template, [{ type: 'CAROUSEL', cards: [cardSend(0, { id: 'm1' }), cardSend(1, { link: 'https://x' })] }])).toMatch(/media id/);
  });

  it('needs the end time and the coupon code for offers', () => {
    const template = { category: 'MARKETING', components: offerComponents };
    const send = (ms: unknown, coupon: string) => [
      { type: 'LIMITED_TIME_OFFER', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: ms } }] },
      { type: 'BUTTON', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: coupon }] },
    ];
    expect(metaSendProblem(template, send(1_767_225_599_000, 'WKND20'))).toBeNull();
    expect(metaSendProblem(template, send(undefined, 'WKND20'))).toMatch(/expiration_time_ms/);
    expect(metaSendProblem(template, send(1_767_225_599_000, 'x'.repeat(16)))).toMatch(/coupon_code/);
  });
});
