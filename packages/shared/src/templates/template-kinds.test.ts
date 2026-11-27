import { describe, expect, it } from 'vitest';
import type { TemplateDraft } from '../template-rules.js';
import { HEADER_MEDIA_KEY, OFFER_CODE_PARAM, cardBodyKey, cardButtonKey, cardReplyPayload, parseCardKey, parseCardReplyPayload, requiredMappingKeys } from './template-kinds.js';

// T007 (feature 009, research R6, R7, R9): mapping keys of the new kinds and card quick reply payloads.
describe('card mapping keys', () => {
  it('builds and parses card keys', () => {
    expect(cardBodyKey(1, 2)).toBe('CARD.1.BODY.2');
    expect(cardButtonKey(0, 1)).toBe('CARD.0.BUTTON.1');
    expect(parseCardKey('CARD.3.BODY.1')).toEqual({ card: 3, part: 'BODY', index: 1 });
    expect(parseCardKey('CARD.0.BUTTON.1')).toEqual({ card: 0, part: 'BUTTON', index: 1 });
    expect(parseCardKey('BODY.1')).toBeNull();
    expect(parseCardKey('CARD.x.BODY.1')).toBeNull();
  });
});

describe('card quick reply payloads', () => {
  it('encode the card and button, zero-based', () => {
    expect(cardReplyPayload(1, 0)).toBe('wbm:c1:b0');
    expect(parseCardReplyPayload('wbm:c1:b0')).toEqual({ cardIndex: 1, buttonIndex: 0 });
    expect(parseCardReplyPayload('wbm:c9:b1')).toEqual({ cardIndex: 9, buttonIndex: 1 });
  });

  it('refuse anything else', () => {
    for (const payload of ['', null, undefined, 'Tell me more', 'wbm:c10:b0', 'wbm:c1:b2', 'wbm:c1', 'xwbm:c1:b0']) expect(parseCardReplyPayload(payload)).toBeNull();
  });
});

describe('requiredMappingKeys', () => {
  const base: TemplateDraft = {
    name: 'x',
    language: 'en_US',
    category: 'MARKETING',
    header: { format: 'TEXT', text: 'Hello {{1}}', textExample: 'Sara' },
    body: { text: 'Hi {{1}}, enjoy {{2}}.', examples: ['Sara', '20%'] },
    buttons: [
      { type: 'QUICK_REPLY', text: 'Stop' },
      { type: 'URL', text: 'Shop', url: 'https://shop.example.com/{{1}}', urlExample: 'a' },
      { type: 'URL', text: 'Home', url: 'https://shop.example.com' },
    ],
  };

  it('lists header, body and url button variables for standard templates', () => {
    expect(requiredMappingKeys(base)).toEqual(['HEADER.1', 'BODY.1', 'BODY.2', 'BUTTON.1']);
  });

  it('adds the media address only when it comes from the campaign', () => {
    const media: TemplateDraft = { ...base, header: { format: 'DOCUMENT', mediaAssetId: 'a' } };
    expect(requiredMappingKeys(media)).toEqual(['BODY.1', 'BODY.2', 'BUTTON.1']);
    expect(requiredMappingKeys(media, { mediaFromAddress: true })).toEqual([HEADER_MEDIA_KEY, 'BODY.1', 'BODY.2', 'BUTTON.1']);
  });

  it('lists card variables for carousels and the code for offers; none for code templates', () => {
    const carousel: TemplateDraft = {
      ...base,
      kind: 'CAROUSEL',
      header: null,
      buttons: [],
      body: { text: 'Hi {{1}}', examples: ['Sara'] },
      cards: [0, 1].map(() => ({
        mediaFormat: 'IMAGE' as const,
        sampleMediaAssetId: 'a',
        bodyText: 'Price {{1}}',
        bodyExamples: ['1'],
        buttons: [
          { type: 'QUICK_REPLY' as const, text: 'More' },
          { type: 'URL' as const, text: 'Shop', url: 'https://shop.example.com/p/{{1}}', urlExample: 'p' },
        ],
      })),
    };
    expect(requiredMappingKeys(carousel)).toEqual(['BODY.1', 'CARD.0.BODY.1', 'CARD.0.BUTTON.1', 'CARD.1.BODY.1', 'CARD.1.BUTTON.1']);
    const offer: TemplateDraft = { ...base, kind: 'LIMITED_TIME_OFFER', header: null, buttons: [base.buttons![1]!], offer: { offerText: 'Deal', showsEndTime: true, codeExample: 'A1' } };
    expect(requiredMappingKeys(offer)).toEqual(['BODY.1', 'BODY.2', 'BUTTON.0', OFFER_CODE_PARAM]);
    expect(requiredMappingKeys({ ...base, kind: 'AUTHENTICATION', category: 'AUTHENTICATION' })).toEqual([]);
  });
});
