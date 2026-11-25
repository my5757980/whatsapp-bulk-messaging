import { extractTemplateVariables, parseVariableKey, type MetaTemplateComponent } from '@wbm/shared';
import { e164ToWaRecipient } from '../../common/phone/phone.js';
import type { TemplateMessagePayload } from '../meta/meta-graph.client.js';

// Maps a message's resolved params to Meta template components (T099,
// contracts/meta-webhooks.md §7).

export type HeaderMediaType = 'image' | 'video' | 'document';

/** resolved_params key holding the public header media URL of an API message. */
export const HEADER_MEDIA_URL_PARAM = '$headerMediaUrl';

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

  return {
    to: e164ToWaRecipient(input.to),
    template: { name: input.template.name, language: { code: input.template.language }, components },
  };
}
