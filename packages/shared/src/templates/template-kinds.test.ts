import { describe, expect, it } from 'vitest';
import { extractTemplateVariables } from '../variables.js';
import { cardBodyKey, cardButtonKey, cardReplyPayload, parseCardKey, parseCardReplyPayload } from './template-kinds.js';

// T007 (feature 009, research R6, R7, R9): mapping keys of the new kinds and card quick reply payloads.
describe('card mapping keys', () => {
  it('builds and parses card keys', () => {
    expect(cardBodyKey(1, 2)).toBe('CARD.1.BODY.2');
    expect(cardButtonKey(0, 1)).toBe('CARD.0.BUTTON.1.1');
    expect(parseCardKey('CARD.3.BODY.1')).toEqual({ card: 3, part: 'BODY', placeholder: '1' });
    expect(parseCardKey('CARD.0.BUTTON.1.1')).toEqual({ card: 0, part: 'BUTTON', button: 1, placeholder: '1' });
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

describe('carousel variables', () => {
  it('are extracted per card from Meta\'s components', () => {
    const card = { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Price {{1}}', example: { body_text: [['AED 120']] } }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'More' }, { type: 'URL', text: 'Shop', url: 'https://s.example.com/{{1}}', example: ['p1'] }] }] };
    expect(extractTemplateVariables([{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Sara']] } }, { type: 'CAROUSEL', cards: [card, card] }])).toEqual([
      { key: 'BODY.1', example: 'Sara' },
      { key: 'CARD.0.BODY.1', example: 'AED 120' },
      { key: 'CARD.0.BUTTON.1.1', example: 'p1' },
      { key: 'CARD.1.BODY.1', example: 'AED 120' },
      { key: 'CARD.1.BUTTON.1.1', example: 'p1' },
    ]);
  });

  it('keep Meta\'s button index for offers (the copy-code button is first)', () => {
    expect(extractTemplateVariables([{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }, { type: 'URL', text: 'Shop', url: 'https://s.example.com/{{1}}', example: ['w'] }] }])).toEqual([{ key: 'BUTTON.1.1', example: 'w' }]);
  });
});
