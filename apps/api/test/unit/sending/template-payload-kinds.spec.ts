import { metaSendProblem, type MetaTemplateComponent } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { OFFER_ENDS_PARAM, buildTemplatePayload } from '../../../src/modules/sending/template-payload.builder.js';

// T030, T040 (feature 009, contracts/meta-templates.md §3, research R6, R7): carousel and offer payloads,
// checked with Meta's send rules.
type Payload = { template: { components: Array<Record<string, unknown>> } };

describe('carousel payloads', () => {
  const card = {
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Linen shirt, {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Tell me more' }, { type: 'URL', text: 'Shop', url: 'https://shop.example.com/p/{{1}}' }] },
    ],
  };
  const components = [{ type: 'BODY', text: 'Hi {{1}}, our new arrivals.' }, { type: 'CAROUSEL', cards: [card, card] }] as unknown as MetaTemplateComponent[];

  it('sends every card with its media id, card text, quick reply payload and link', () => {
    const payload = buildTemplatePayload({
      to: '+971501234567',
      template: { name: 'new_arrivals', language: 'en_US', parameterFormat: 'POSITIONAL', components },
      params: { 'BODY.1': 'Sara', 'CARD.0.BODY.1': 'AED 120', 'CARD.0.BUTTON.1.1': 'shirt-1', 'CARD.1.BODY.1': 'AED 90', 'CARD.1.BUTTON.1.1': 'shirt-2' },
      cardMedia: [{ type: 'image', id: 'm1' }, { type: 'image', id: 'm2' }],
    }) as unknown as Payload;
    const sent = payload.template.components;
    expect(sent[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Sara' }] });
    expect(sent[1]).toEqual({
      type: 'carousel',
      cards: [
        {
          card_index: 0,
          components: [
            { type: 'header', parameters: [{ type: 'image', image: { id: 'm1' } }] },
            { type: 'body', parameters: [{ type: 'text', text: 'AED 120' }] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'wbm:c0:b0' }] },
            { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'shirt-1' }] },
          ],
        },
        {
          card_index: 1,
          components: [
            { type: 'header', parameters: [{ type: 'image', image: { id: 'm2' } }] },
            { type: 'body', parameters: [{ type: 'text', text: 'AED 90' }] },
            { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'wbm:c1:b0' }] },
            { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'shirt-2' }] },
          ],
        },
      ],
    });
    expect(metaSendProblem({ category: 'MARKETING', components }, sent.map((c) => ({ ...c, type: String(c.type).toUpperCase() })))).toBeNull();
  });

  it('needs the media of every card', () => {
    expect(() => buildTemplatePayload({ to: '+971501234567', template: { name: 'new_arrivals', language: 'en_US', parameterFormat: 'POSITIONAL', components }, params: {}, cardMedia: [{ type: 'image', id: 'm1' }] })).toThrow(/card 2/);
  });
});

describe('limited-time offer payloads', () => {
  const components = [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Weekend deal', has_expiration: true } },
    { type: 'BODY', text: 'Hi {{1}}, 20% off until Sunday.' },
    { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'WKND20' }, { type: 'URL', text: 'Shop now', url: 'https://shop.example.com/offer/{{1}}' }] },
  ] as unknown as MetaTemplateComponent[];

  it('sends the end time, the recipient\'s code at index 0 and the link at index 1', () => {
    const ends = Date.UTC(2026, 11, 31, 23, 59);
    const payload = buildTemplatePayload({
      to: '+971501234567',
      template: { name: 'weekend_offer', language: 'en_US', parameterFormat: 'POSITIONAL', components },
      params: { 'BODY.1': 'Sara', 'BUTTON.1.1': 'wknd', $offerCode: 'SARA20', [OFFER_ENDS_PARAM]: String(ends) },
      headerMedia: { type: 'image', id: 'h1' },
    }) as unknown as Payload;
    const sent = payload.template.components;
    expect(sent).toContainEqual({ type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: ends } }] });
    expect(sent).toContainEqual({ type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: 'SARA20' }] });
    expect(sent).toContainEqual({ type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'wknd' }] });
    expect(metaSendProblem({ category: 'MARKETING', components }, sent.map((c) => ({ ...c, type: String(c.type).toUpperCase() })))).toBeNull();
  });
});
