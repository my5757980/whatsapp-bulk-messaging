import { metaSendProblem } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { authenticationPayload } from '../../../src/modules/sending/template-payload.builder.js';

// T019 (feature 009, research R2): the code goes in the body and the button parameter, as Meta needs.
describe('authenticationPayload', () => {
  it('puts the code twice and passes Meta\'s send rule', () => {
    const payload = authenticationPayload('+971501234567', { name: 'login_code', language: 'en_US' }, '482913') as unknown as {
      to: string;
      template: { name: string; language: { code: string }; components: unknown[] };
    };
    expect(payload.to).toBe('971501234567');
    expect(payload.template).toEqual({
      name: 'login_code',
      language: { code: 'en_US' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
      ],
    });
    const template = { category: 'AUTHENTICATION', components: [{ type: 'BODY', add_security_recommendation: true }, { type: 'BUTTONS', buttons: [{ type: 'URL', otp_type: 'COPY_CODE' }] }] };
    expect(metaSendProblem(template, payload.template.components)).toBeNull();
  });
});
