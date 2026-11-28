import { describe, expect, it } from 'vitest';
import { renderFlowText } from '../../../src/modules/flows/engine/render.js';

// Feature 010 (US3, T042): {global:key} in flow messages, next to contact values and answers.
const contact = { name: 'Sara Khan', phoneE164: '+971500000001', attributes: { city: 'Dubai' }, globals: { store_hours: '9 am to 9 pm', empty_one: '' } };

describe('renderFlowText', () => {
  it('fills global attributes with contact values and answers', () => {
    expect(renderFlowText('Hi {first_name}, we open {global:store_hours} in {attr:city}. You chose {answer:size}.', contact, {}, { size: 'M' })).toBe(
      'Hi Sara, we open 9 am to 9 pm in Dubai. You chose M.',
    );
  });

  it('uses the step fallback for an unknown or empty global attribute, otherwise renders it empty', () => {
    expect(renderFlowText('Open {global:empty_one}', contact, { 'global:empty_one': 'daily' }, {})).toBe('Open daily');
    expect(renderFlowText('Open {global:unknown}.', contact, {}, {})).toBe('Open .');
  });

  it('never treats an answer as a placeholder', () => {
    expect(renderFlowText('You wrote: {answer:note}', contact, {}, { note: '{global:store_hours}' })).toBe('You wrote: {global:store_hours}');
  });
});
