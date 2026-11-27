import { extractTemplateVariables, parseVariableKey, type MetaTemplateComponent } from '@wbm/shared';
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
