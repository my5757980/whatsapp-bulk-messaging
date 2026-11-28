import { OFFER_CODE_PARAM, bodyPlaceholders, cardReplyPayload, extractTemplateVariables, parseVariableKey, type MetaTemplateComponent } from '@wbm/shared';
import { e164ToWaRecipient } from '../../common/phone/phone.js';
import type { TemplateMessagePayload } from '../meta/meta-graph.client.js';

// Maps a message's resolved params to Meta template components (T099,
// contracts/meta-webhooks.md §7).

export type HeaderMediaType = 'image' | 'video' | 'document';

/** resolved_params key holding the public header media URL of an API message. */
export const HEADER_MEDIA_URL_PARAM = '$headerMediaUrl';

/**
 * Feature 008 (R10): resolved_params key holding a catalog or multi-product template's product choices,
 * as JSON {thumbnailRetailerId, sections: [{title, retailerIds}]}; a campaign maps it as static text.
 */
export const PRODUCTS_PARAM = '$products';

/** Feature 008 (US7): resolved_params key holding the signed token of a template's form (FLOW) button. */
export const FLOW_TOKEN_PARAM = '$flowToken';

/** Feature 009 (research R7): resolved_params key holding an offer's end as Unix milliseconds. */
export const OFFER_ENDS_PARAM = '$offerEndsAt';

interface ProductChoices {
  thumbnailRetailerId?: string | null;
  sections?: Array<{ title?: string | null; retailerIds?: string[] }>;
}

function productChoices(raw: string | undefined): ProductChoices {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ProductChoices;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export interface PayloadInput {
  /** Recipient in E.164. */
  to: string;
  template: {
    name: string;
    language: string;
    parameterFormat: 'POSITIONAL' | 'NAMED';
    components: MetaTemplateComponent[];
  };
  params: Record<string, string>;
  headerMedia?: { type: HeaderMediaType; id: string } | { type: HeaderMediaType; link: string };
  /** Feature 009 (research R6): each carousel card's media, uploaded to the sending number. */
  cardMedia?: Array<{ type: 'image' | 'video'; id: string }>;
}

const MEDIA_FORMATS: Record<string, HeaderMediaType> = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

/** Header media type of a template, or null for text / no header. */
export function headerMediaType(components: MetaTemplateComponent[]): HeaderMediaType | null {
  const header = components.find((c) => c.type.toUpperCase() === 'HEADER');
  return header?.format ? (MEDIA_FORMATS[header.format.toUpperCase()] ?? null) : null;
}

function textParam(text: string, placeholder: string, named: boolean): Record<string, unknown> {
  return named ? { type: 'text', text, parameter_name: placeholder } : { type: 'text', text };
}

/**
 * A one-time code message (feature 009, research R2): the code is the body parameter and the
 * button parameter (`sub_type: url`, index 0), as Meta's authentication templates need.
 */
export function authenticationPayload(to: string, template: { name: string; language: string }, code: string): TemplateMessagePayload {
  return {
    to: to.replace(/^\+/, ''),
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  } as unknown as TemplateMessagePayload;
}

export function buildTemplatePayload(input: PayloadInput): TemplateMessagePayload {
  const named = input.template.parameterFormat === 'NAMED';
  const components: Array<Record<string, unknown>> = [];

  // Group the template's variables by component, keeping one entry per placeholder.
  const header: string[] = [];
  const body: string[] = [];
  const buttons = new Map<number, string[]>();
  for (const { key } of extractTemplateVariables(input.template.components)) {
    const ref = parseVariableKey(key);
    if (!ref) continue;
    const list = ref.component === 'HEADER' ? header : ref.component === 'BODY' ? body : buttons.get(ref.index ?? 0) ?? [];
    if (!list.includes(ref.placeholder)) list.push(ref.placeholder);
    if (ref.component === 'BUTTON') buttons.set(ref.index ?? 0, list);
  }
  // Positional parameters must be sent in {{1}}, {{2}}, ... order.
  if (!named) body.sort((a, b) => Number(a) - Number(b));

  const mediaType = headerMediaType(input.template.components);
  if (mediaType) {
    if (!input.headerMedia) throw new Error(`Template "${input.template.name}" needs header media (${mediaType})`);
    components.push({
      type: 'header',
      parameters: [{ type: input.headerMedia.type, [input.headerMedia.type]: 'id' in input.headerMedia ? { id: input.headerMedia.id } : { link: input.headerMedia.link } }],
    });
  } else if (header.length) {
    components.push({
      type: 'header',
      parameters: header.map((p) => textParam(input.params[`HEADER.${p}`] ?? '', p, named)),
    });
  }

  if (body.length) {
    components.push({ type: 'body', parameters: body.map((p) => textParam(input.params[`BODY.${p}`] ?? '', p, named)) });
  }

  // Feature 009 (research R7): an offer's end and the copy-code button's code.
  const offer = input.template.components.find((c) => c.type.toUpperCase() === 'LIMITED_TIME_OFFER') as unknown as { limited_time_offer?: { has_expiration?: boolean } } | undefined;
  if (offer) {
    if (offer.limited_time_offer?.has_expiration) components.push({ type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: Number(input.params[OFFER_ENDS_PARAM] ?? 0) } }] });
    components.push({ type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: input.params[OFFER_CODE_PARAM] ?? '' }] });
  }

  // Feature 009 (research R6): every card with its media, card text and buttons; quick replies say which card.
  const carousel = input.template.components.find((c) => c.type.toUpperCase() === 'CAROUSEL');
  if (carousel) {
    const cards = (carousel.cards ?? []).map((card, i) => {
      const media = input.cardMedia?.[i];
      if (!media) throw new Error(`Template "${input.template.name}" needs media for card ${i + 1}`);
      const parts = card.components ?? [];
      const cardComponents: Array<Record<string, unknown>> = [{ type: 'header', parameters: [{ type: media.type, [media.type]: { id: media.id } }] }];
      const cardBody = parts.find((p) => p.type.toUpperCase() === 'BODY');
      const names = bodyPlaceholders(cardBody?.text ?? '').sort((a, b) => Number(a) - Number(b));
      if (names.length) cardComponents.push({ type: 'body', parameters: names.map((n) => ({ type: 'text', text: input.params[`CARD.${i}.BODY.${n}`] ?? '' })) });
      (parts.find((p) => p.type.toUpperCase() === 'BUTTONS')?.buttons ?? []).forEach((button, b) => {
        const type = button.type.toUpperCase();
        if (type === 'QUICK_REPLY') cardComponents.push({ type: 'button', sub_type: 'quick_reply', index: String(b), parameters: [{ type: 'payload', payload: cardReplyPayload(i, b) }] });
        else if (type === 'URL' && /\{\{\s*1\s*\}\}/.test(button.url ?? '')) cardComponents.push({ type: 'button', sub_type: 'url', index: String(b), parameters: [{ type: 'text', text: input.params[`CARD.${i}.BUTTON.${b}.1`] ?? '' }] });
      });
      return { card_index: i, components: cardComponents };
    });
    components.push({ type: 'carousel', cards });
  }

  for (const [index, placeholders] of [...buttons.entries()].sort(([a], [b]) => a - b)) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters: placeholders.map((p) => ({ type: 'text', text: input.params[`BUTTON.${index}.${p}`] ?? '' })),
    });
  }

  // Quick-reply buttons with a per-message payload (feature 006, COD answers): BUTTON.{index}.payload.
  const quickReplies = Object.entries(input.params)
    .map(([key, value]) => [/^BUTTON\.(\d+)\.payload$/.exec(key)?.[1], value] as const)
    .filter((entry): entry is readonly [string, string] => entry[0] !== undefined)
    .sort(([a], [b]) => Number(a) - Number(b));
  for (const [index, payload] of quickReplies) {
    components.push({ type: 'button', sub_type: 'quick_reply', index, parameters: [{ type: 'payload', payload }] });
  }

  // Catalog and multi-product buttons (feature 008): their action carries the product choices.
  const templateButtons = (input.template.components.find((c) => c.type.toUpperCase() === 'BUTTONS') as unknown as { buttons?: Array<{ type: string }> } | undefined)?.buttons ?? [];
  const choices = productChoices(input.params[PRODUCTS_PARAM]);
  templateButtons.forEach((button, index) => {
    const kind = button.type.toUpperCase();
    if (kind === 'CATALOG') {
      components.push({ type: 'button', sub_type: 'CATALOG', index: String(index), parameters: choices.thumbnailRetailerId ? [{ type: 'action', action: { thumbnail_product_retailer_id: choices.thumbnailRetailerId } }] : [] });
    } else if (kind === 'FLOW') {
      components.push({ type: 'button', sub_type: 'flow', index: String(index), parameters: [{ type: 'action', action: { flow_token: input.params[FLOW_TOKEN_PARAM] ?? 'unused' } }] });
    } else if (kind === 'MPM') {
      const sections = (choices.sections ?? []).map((s) => ({ ...(s.title ? { title: s.title } : {}), product_items: (s.retailerIds ?? []).map((id) => ({ product_retailer_id: id })) }));
      components.push({ type: 'button', sub_type: 'mpm', index: String(index), parameters: [{ type: 'action', action: { ...(choices.thumbnailRetailerId ? { thumbnail_product_retailer_id: choices.thumbnailRetailerId } : {}), sections } }] });
    }
  });

  return {
    to: e164ToWaRecipient(input.to),
    template: { name: input.template.name, language: { code: input.template.language }, components },
  };
}
