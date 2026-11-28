import { bodyPlaceholders, kindOf, type AuthTemplateOptions, type CarouselCardDraft, type OfferDraft, type TemplateButtonDraft, type TemplateDraft, type TemplateKind } from '@wbm/shared';
import type { Template } from '../../generated/prisma/client.js';

// TemplateInput <-> Meta template components (T138). Examples are required by Meta for every
// variable; media headers carry the Resumable Upload handle in `example.header_handle`.

type Component = Record<string, unknown>;

const HAS_HEADER_VARIABLE = /\{\{\s*1\s*\}\}/;
const URL_VARIABLE_AT_END = /\{\{\s*1\s*\}\}$/;

/** Meta wants the full example link for a URL button with a variable suffix. */
function exampleUrl(url: string, example: string): string {
  return /^https?:\/\//i.test(example) ? example : url.replace(URL_VARIABLE_AT_END, example);
}

function toMetaButton(button: TemplateButtonDraft): Component {
  switch (button.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: button.text };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: button.text, phone_number: button.phoneNumber };
    case 'URL': {
      const url = button.url ?? '';
      return URL_VARIABLE_AT_END.test(url)
        ? { type: 'URL', text: button.text, url, example: [exampleUrl(url, button.urlExample ?? '')] }
        : { type: 'URL', text: button.text, url };
    }
    // Feature 008 (contracts/meta-commerce-graph.md): catalog, product list and form buttons.
    case 'CATALOG':
      return { type: 'CATALOG', text: button.text };
    case 'MPM':
      return { type: 'MPM', text: button.text };
    case 'FLOW':
      return { type: 'FLOW', text: button.text, flow_id: button.flowId, navigate_screen: 'S1', flow_action: 'navigate' };
  }
}

/** Body component with its examples (Meta needs one example per variable). */
function bodyComponent(text: string, examples: readonly string[] | undefined): Component {
  const count = bodyPlaceholders(text).length;
  return count ? { type: 'BODY', text, example: { body_text: [(examples ?? []).slice(0, count).map((e) => e.trim())] } } : { type: 'BODY', text };
}

/** Feature 009 (research R2): Meta fixes the body; we send the options. */
function authenticationComponents(auth: AuthTemplateOptions): Component[] {
  const button: Component = { type: 'OTP', otp_type: auth.button };
  if (auth.buttonText) button.text = auth.buttonText;
  if (auth.button === 'ONE_TAP') {
    if (auth.autofillText) button.autofill_text = auth.autofillText;
    button.supported_apps = (auth.apps ?? []).map((a) => ({ package_name: a.packageName, signature_hash: a.signatureHash }));
  }
  return [
    { type: 'BODY', add_security_recommendation: auth.securityNote },
    ...(auth.codeExpiryMinutes ? [{ type: 'FOOTER', code_expiration_minutes: auth.codeExpiryMinutes }] : []),
    { type: 'BUTTONS', buttons: [button] },
  ];
}

/** Feature 009 (research R6): a message body and 2–10 cards, each with its own sample handle. */
function carouselComponents(input: TemplateDraft, cardHandles: readonly (string | undefined)[]): Component[] {
  const cards = (input.cards ?? []).map((card: CarouselCardDraft, i: number) => ({
    components: [
      { type: 'HEADER', format: card.mediaFormat, example: { header_handle: [cardHandles[i]] } },
      ...(card.bodyText?.trim() ? [bodyComponent(card.bodyText, card.bodyExamples)] : []),
      ...(card.buttons.length ? [{ type: 'BUTTONS', buttons: card.buttons.map(toMetaButton) }] : []),
    ],
  }));
  return [bodyComponent(input.body.text, input.body.examples), { type: 'CAROUSEL', cards }];
}

/** Feature 009 (research R7): header, the offer, the body, a copy-code and a website button; no footer. */
function offerComponents(input: TemplateDraft, headerHandle: string | undefined): Component[] {
  const offer = input.offer as OfferDraft;
  return [
    ...(input.header && input.header.format !== 'TEXT' ? [{ type: 'HEADER', format: input.header.format, example: { header_handle: [headerHandle] } }] : []),
    { type: 'LIMITED_TIME_OFFER', limited_time_offer: { text: offer.offerText, has_expiration: offer.showsEndTime } },
    bodyComponent(input.body.text, input.body.examples),
    { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: offer.codeExample }, ...(input.buttons ?? []).map(toMetaButton)] },
  ];
}

/** The kind's settings kept with the template (data-model.md `options`). */
export function kindOptions(input: TemplateDraft): Record<string, unknown> {
  switch (kindOf(input)) {
    case 'AUTHENTICATION':
      return { ...(input.auth ?? {}) };
    case 'CAROUSEL':
      return { cardMediaFormat: input.cards?.[0]?.mediaFormat ?? 'IMAGE', cards: (input.cards ?? []).map((c) => ({ sampleMediaAssetId: c.sampleMediaAssetId })) };
    case 'LIMITED_TIME_OFFER':
      return { ...(input.offer ?? {}) };
    default:
      return {};
  }
}

export function buildTemplateComponents(input: TemplateDraft, headerHandle?: string, cardHandles: readonly (string | undefined)[] = []): Component[] {
  const kind = kindOf(input);
  if (kind === 'AUTHENTICATION') return authenticationComponents(input.auth as AuthTemplateOptions);
  if (kind === 'CAROUSEL') return carouselComponents(input, cardHandles);
  if (kind === 'LIMITED_TIME_OFFER') return offerComponents(input, headerHandle);
  const components: Component[] = [];
  const header = input.header;
  if (header?.format === 'TEXT') {
    const text = header.text ?? '';
    components.push(
      HAS_HEADER_VARIABLE.test(text)
        ? { type: 'HEADER', format: 'TEXT', text, example: { header_text: [header.textExample ?? ''] } }
        : { type: 'HEADER', format: 'TEXT', text },
    );
  } else if (header) {
    components.push({ type: 'HEADER', format: header.format, example: { header_handle: [headerHandle] } });
  }

  components.push(bodyComponent(input.body.text, input.body.examples));
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer });
  if (input.buttons?.length) components.push({ type: 'BUTTONS', buttons: input.buttons.map(toMetaButton) });
  return components;
}

interface MetaComponentLike {
  type?: string;
  format?: string;
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][] };
  buttons?: Array<{ type?: string; text?: string; url?: string; phone_number?: string; example?: string[] | string }>;
  cards?: Array<{ components?: MetaComponentLike[] }>;
  limited_time_offer?: { text?: string; has_expiration?: boolean };
}

const upper = (v: string | undefined) => (v ?? '').toUpperCase();

function draftButtons(component: MetaComponentLike | undefined): TemplateButtonDraft[] {
  return (component?.buttons ?? []).flatMap((b): TemplateButtonDraft[] => {
    switch (upper(b.type)) {
      case 'QUICK_REPLY':
        return [{ type: 'QUICK_REPLY', text: b.text ?? '' }];
      case 'URL':
        return [{ type: 'URL', text: b.text ?? '', url: b.url ?? '', ...(b.example?.[0] ? { urlExample: b.example[0] } : {}) }];
      case 'PHONE_NUMBER':
        return [{ type: 'PHONE_NUMBER', text: b.text ?? '', phoneNumber: b.phone_number ?? '' }];
      default:
        return []; // copy-code, flow and other button types are not editable here
    }
  });
}

/** Rebuilds an editable TemplateInput from a stored template ("Duplicate & edit"). */
export function templateToDraft(t: Template): TemplateDraft & { wabaId: string } {
  const components = (Array.isArray(t.components) ? t.components : []) as MetaComponentLike[];
  const find = (type: string) => components.find((c) => upper(c.type) === type);
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = draftButtons(find('BUTTONS'));
  const kind = (t.kind ?? 'STANDARD') as TemplateKind;
  const options = (t.options ?? {}) as Record<string, unknown>;
  const name = t.status === 'DRAFT' && !t.metaTemplateId ? t.name : `${t.name}_copy`.slice(0, 512);
  const kindFields: Partial<TemplateDraft> = { kind, ttlSeconds: t.ttlSeconds ?? null };
  if (kind === 'AUTHENTICATION') {
    return { wabaId: t.wabaId, name, language: t.language, category: t.category, ...kindFields, header: null, body: { text: '' }, footer: null, buttons: [], auth: options as unknown as AuthTemplateOptions };
  }
  if (kind === 'CAROUSEL') {
    const samples = (Array.isArray(options.cards) ? options.cards : []) as Array<{ sampleMediaAssetId?: string | null }>;
    const cards: CarouselCardDraft[] = (find('CAROUSEL')?.cards ?? []).map((card, i) => {
      const parts = card.components ?? [];
      const cardHeader = parts.find((c) => upper(c.type) === 'HEADER');
      const cardBody = parts.find((c) => upper(c.type) === 'BODY');
      return { mediaFormat: upper(cardHeader?.format) === 'VIDEO' ? 'VIDEO' : 'IMAGE', sampleMediaAssetId: samples[i]?.sampleMediaAssetId ?? null, bodyText: cardBody?.text ?? '', bodyExamples: cardBody?.example?.body_text?.[0] ?? [], buttons: draftButtons(parts.find((c) => upper(c.type) === 'BUTTONS')) };
    });
    return { wabaId: t.wabaId, name, language: t.language, category: t.category, ...kindFields, header: null, body: { text: body?.text ?? '', examples: body?.example?.body_text?.[0] ?? [] }, footer: null, buttons: [], cards };
  }
  const headerFormat = upper(header?.format) || 'TEXT';
  return {
    wabaId: t.wabaId,
    // A local draft (004 US9) is opened for review under its own name, so submitting it replaces the draft.
    name,
    ...kindFields,
    ...(kind === 'LIMITED_TIME_OFFER' ? { offer: options as unknown as OfferDraft } : {}),
    language: t.language,
    category: t.category,
    header: header
      ? headerFormat === 'TEXT'
        ? { format: 'TEXT', text: header.text ?? '', ...(header.example?.header_text?.[0] ? { textExample: header.example.header_text[0] } : {}) }
        : { format: headerFormat as 'IMAGE' | 'VIDEO' | 'DOCUMENT', ...(t.headerMediaAssetId ? { mediaAssetId: t.headerMediaAssetId } : {}) }
      : null,
    body: { text: body?.text ?? '', examples: body?.example?.body_text?.[0] ?? [] },
    footer: footer?.text ?? null,
    buttons,
  };
}
