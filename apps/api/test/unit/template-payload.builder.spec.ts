import { describe, expect, it } from 'vitest';
import { buildTemplatePayload } from '../../src/modules/sending/template-payload.builder.js';

// T099: resolved params -> Meta template components (contracts/meta-webhooks.md §7).
const components = [
  { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
  { type: 'BODY', text: 'Your order {{2}} ships to {{1}}.' },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop' }, { type: 'URL', text: 'Track', url: 'https://x.test/t/{{1}}' }] },
];

describe('buildTemplatePayload', () => {
  it('maps header text, positional body params in order and the URL button suffix', () => {
    const payload = buildTemplatePayload({
      to: '+971501234567',
      template: { name: 'order_update', language: 'en_US', parameterFormat: 'POSITIONAL', components },
      params: { 'HEADER.1': 'Sara', 'BODY.1': 'Dubai', 'BODY.2': 'A-17', 'BUTTON.1.1': 'A17' },
    });
    expect(payload).toEqual({
      to: '971501234567',
      template: {
        name: 'order_update',
        language: { code: 'en_US' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Sara' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Dubai' }, { type: 'text', text: 'A-17' }] },
          { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'A17' }] },
        ],
      },
    });
  });

  it('names parameters for NAMED templates and sends header media by id', () => {
    const payload = buildTemplatePayload({
      to: '+15550001111',
      template: {
        name: 'promo',
        language: 'en',
        parameterFormat: 'NAMED',
        components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello {{first_name}}' }],
      },
      params: { 'BODY.first_name': 'Ali' },
      headerMedia: { type: 'image', id: 'MEDIA1' },
    });
    expect(payload.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA1' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ali', parameter_name: 'first_name' }] },
    ]);
  });

  it('sends quick-reply payloads for BUTTON.{index}.payload, in button order (006 COD)', () => {
    const payload = buildTemplatePayload({
      to: '+971501234567',
      template: {
        name: 'cod_confirm',
        language: 'en',
        parameterFormat: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Confirm order {{1}}?' },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'No' }] },
        ],
      },
      params: { 'BODY.1': '#1001', 'BUTTON.1.payload': 'cod1:abc:N', 'BUTTON.0.payload': 'cod1:abc:Y' },
    });
    expect(payload.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '#1001' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'cod1:abc:Y' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'cod1:abc:N' }] },
    ]);
  });

  it('omits components without parameters', () => {
    const payload = buildTemplatePayload({
      to: '+15550001111',
      template: { name: 'hello', language: 'en_US', parameterFormat: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hello!' }] },
      params: {},
    });
    expect(payload.template.components).toEqual([]);
  });

  it('refuses a media header without a media id', () => {
    expect(() =>
      buildTemplatePayload({
        to: '+15550001111',
        template: { name: 'promo', language: 'en', parameterFormat: 'POSITIONAL', components: [{ type: 'HEADER', format: 'VIDEO' }] },
        params: {},
      }),
    ).toThrow(/header media/i);
  });
});
