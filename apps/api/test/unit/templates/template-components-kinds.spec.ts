import { metaCreateProblem, type TemplateDraft } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { buildTemplateComponents, kindOptions, templateToDraft } from '../../../src/modules/templates/template-components.builder.js';
import type { Template } from '../../../src/generated/prisma/client.js';

// T019, T030, T040 (feature 009, contracts/meta-templates.md §1): our drafts of each kind to Meta's
// components, checked with Meta's own rules, and back to drafts for "Duplicate & edit".
const base = { wabaId: 'W1', language: 'en_US' };

describe('authentication templates', () => {
  const draft = (auth: TemplateDraft['auth']): TemplateDraft => ({ ...base, name: 'login_code', category: 'AUTHENTICATION', kind: 'AUTHENTICATION', body: { text: '' }, auth });

  it('maps copy code with the security note and the validity footer', () => {
    const components = buildTemplateComponents(draft({ securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' }));
    expect(components).toEqual([
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ]);
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components, message_send_ttl_seconds: 600 })).toBeNull();
  });

  it('maps one-tap with the supported apps and leaves the footer out without a validity', () => {
    const components = buildTemplateComponents(draft({ securityNote: false, codeExpiryMinutes: null, button: 'ONE_TAP', autofillText: 'Autofill', apps: [{ packageName: 'com.example.app', signatureHash: 'K8a/AINcGX7' }] }));
    expect(components).toEqual([
      { type: 'BODY', add_security_recommendation: false },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'ONE_TAP', autofill_text: 'Autofill', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] }] },
    ]);
    expect(metaCreateProblem({ category: 'AUTHENTICATION', components })).toBeNull();
  });

  it('keeps the options and rebuilds the draft', () => {
    const auth = { securityNote: true, codeExpiryMinutes: 5, button: 'COPY_CODE' as const };
    expect(kindOptions(draft(auth))).toEqual(auth);
    const row = { wabaId: 'W1', name: 'login_code', language: 'en_US', category: 'AUTHENTICATION', kind: 'AUTHENTICATION', options: auth, ttlSeconds: 300, components: [], status: 'APPROVED', metaTemplateId: 'T1', headerMediaAssetId: null } as unknown as Template;
    expect(templateToDraft(row)).toMatchObject({ name: 'login_code_copy', kind: 'AUTHENTICATION', category: 'AUTHENTICATION', ttlSeconds: 300, auth, header: null, buttons: [] });
  });
});

describe('carousel templates', () => {
  const card = (i: number) => ({
    mediaFormat: 'IMAGE' as const,
    sampleMediaAssetId: `asset-${i}`,
    bodyText: 'Linen shirt, {{1}}',
    bodyExamples: ['AED 120'],
    buttons: [
      { type: 'QUICK_REPLY' as const, text: 'Tell me more' },
      { type: 'URL' as const, text: 'Shop', url: 'https://shop.example.com/p/{{1}}', urlExample: 'shirt-1' },
    ],
  });
  const draft: TemplateDraft = { ...base, name: 'new_arrivals', category: 'MARKETING', kind: 'CAROUSEL', body: { text: 'Hi {{1}}, our new arrivals.', examples: ['Sara'] }, cards: [card(0), card(1)] };

  it('maps the message body and each card with its own sample handle', () => {
    const components = buildTemplateComponents(draft, undefined, ['h0', 'h1']);
    expect(components[0]).toEqual({ type: 'BODY', text: 'Hi {{1}}, our new arrivals.', example: { body_text: [['Sara']] } });
    expect(components[1]).toMatchObject({
      type: 'CAROUSEL',
      cards: [
        { components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h0'] } }, { type: 'BODY', text: 'Linen shirt, {{1}}', example: { body_text: [['AED 120']] } }, { type: 'BUTTONS' }] },
        { components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h1'] } }, { type: 'BODY' }, { type: 'BUTTONS' }] },
      ],
    });
    expect(metaCreateProblem({ category: 'MARKETING', components })).toBeNull();
    expect(kindOptions(draft)).toEqual({ cardMediaFormat: 'IMAGE', cards: [{ sampleMediaAssetId: 'asset-0' }, { sampleMediaAssetId: 'asset-1' }] });
  });

  it('rebuilds the cards from the stored components and samples', () => {
    const components = buildTemplateComponents(draft, undefined, ['h0', 'h1']);
    const row = { wabaId: 'W1', name: 'new_arrivals', language: 'en_US', category: 'MARKETING', kind: 'CAROUSEL', options: kindOptions(draft), ttlSeconds: null, components, status: 'APPROVED', metaTemplateId: 'T2', headerMediaAssetId: null } as unknown as Template;
    const back = templateToDraft(row);
    expect(back.cards).toHaveLength(2);
    expect(back.cards?.[1]).toMatchObject({ mediaFormat: 'IMAGE', sampleMediaAssetId: 'asset-1', bodyText: 'Linen shirt, {{1}}', bodyExamples: ['AED 120'] });
    expect(back.cards?.[0]?.buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL']);
  });
});

describe('limited-time offer templates', () => {
  const draft: TemplateDraft = {
    ...base,
    name: 'weekend_offer',
    category: 'MARKETING',
    kind: 'LIMITED_TIME_OFFER',
    header: { format: 'IMAGE', mediaAssetId: 'asset-h' },
    body: { text: 'Hi {{1}}, 20% off until Sunday.', examples: ['Sara'] },
    buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/offer/{{1}}', urlExample: 'wknd' }],
    offer: { offerText: 'Weekend deal', showsEndTime: true, codeExample: 'WKND20' },
  };

  it('maps the header, the offer, the body and the copy-code and website buttons, with no footer', () => {
    const components = buildTemplateComponents(draft, 'hh');
    expect(components.map((c) => c.type)).toEqual(['HEADER', 'LIMITED_TIME_OFFER', 'BODY', 'BUTTONS']);
    expect(components[1]).toEqual({ type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: 'Weekend deal', has_expiration: true } });
    expect((components[3] as { buttons: unknown[] }).buttons[0]).toEqual({ type: 'COPY_CODE', example: 'WKND20' });
    expect(metaCreateProblem({ category: 'MARKETING', components })).toBeNull();
    expect(kindOptions(draft)).toEqual({ offerText: 'Weekend deal', showsEndTime: true, codeExample: 'WKND20' });
  });
});
