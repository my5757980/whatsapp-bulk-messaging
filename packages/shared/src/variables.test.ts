import { describe, expect, it } from 'vitest';
import { extractTemplateVariables, formatVariableKey, parseVariableKey } from './variables.js';

describe('variable keys', () => {
  it('formats and parses BODY, HEADER and BUTTON keys', () => {
    expect(formatVariableKey({ component: 'BODY', placeholder: '1' })).toBe('BODY.1');
    expect(formatVariableKey({ component: 'BUTTON', index: 0, placeholder: '1' })).toBe('BUTTON.0.1');
    expect(parseVariableKey('HEADER.1')).toEqual({ component: 'HEADER', placeholder: '1' });
    expect(parseVariableKey('BUTTON.1.1')).toEqual({ component: 'BUTTON', index: 1, placeholder: '1' });
    expect(parseVariableKey('BODY.customer_name')).toEqual({ component: 'BODY', placeholder: 'customer_name' });
  });

  it('rejects malformed keys', () => {
    expect(parseVariableKey('FOOTER.1')).toBeNull();
    expect(parseVariableKey('BUTTON.x.1')).toBeNull();
    expect(parseVariableKey('BODY')).toBeNull();
  });
});

describe('extractTemplateVariables', () => {
  it('reads positional placeholders with examples from Meta components', () => {
    const vars = extractTemplateVariables([
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}', example: { header_text: ['Sara'] } },
      {
        type: 'BODY',
        text: 'Your order {{1}} ships on {{2}}.',
        example: { body_text: [['#123', 'Monday']] },
      },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Yes' },
          { type: 'URL', text: 'Track', url: 'https://example.com/t/{{1}}', example: ['abc'] },
        ],
      },
    ]);
    expect(vars).toEqual([
      { key: 'HEADER.1', example: 'Sara' },
      { key: 'BODY.1', example: '#123' },
      { key: 'BODY.2', example: 'Monday' },
      { key: 'BUTTON.1.1', example: 'abc' },
    ]);
  });

  it('reads named placeholders', () => {
    const vars = extractTemplateVariables([
      {
        type: 'BODY',
        text: 'Hello {{first_name}}, code {{code}}',
        example: { body_text_named_params: [{ param_name: 'first_name', example: 'Ali' }, { param_name: 'code', example: '42' }] },
      },
    ]);
    expect(vars).toEqual([
      { key: 'BODY.first_name', example: 'Ali' },
      { key: 'BODY.code', example: '42' },
    ]);
  });

  it('ignores media headers and components without placeholders', () => {
    expect(extractTemplateVariables([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Plain text' }])).toEqual([]);
  });
});
