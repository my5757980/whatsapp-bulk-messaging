import { bodyPlaceholders, type TemplateButtonDraft, type TemplateDraft } from '@wbm/shared';
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
  }
}

export function buildTemplateComponents(input: TemplateDraft, headerHandle?: string): Component[] {
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

  const count = bodyPlaceholders(input.body.text).length;
  components.push(
    count
      ? { type: 'BODY', text: input.body.text, example: { body_text: [(input.body.examples ?? []).slice(0, count).map((e) => e.trim())] } }
      : { type: 'BODY', text: input.body.text },
  );
  if (input.footer) components.push({ type: 'FOOTER', text: input.footer });
  if (input.buttons?.length) components.push({ type: 'BUTTONS', buttons: input.buttons.map(toMetaButton) });
  return components;
}

interface MetaComponentLike {
  type?: string;
  format?: string;
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][] };
  buttons?: Array<{ type?: string; text?: string; url?: string; phone_number?: string; example?: string[] }>;
}

const upper = (v: string | undefined) => (v ?? '').toUpperCase();

/** Rebuilds an editable TemplateInput from a stored template ("Duplicate & edit"). */
export function templateToDraft(t: Template): TemplateDraft & { wabaId: string } {
  const components = (Array.isArray(t.components) ? t.components : []) as MetaComponentLike[];
  const find = (type: string) => components.find((c) => upper(c.type) === type);
  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = (find('BUTTONS')?.buttons ?? []).flatMap((b): TemplateButtonDraft[] => {
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

  const headerFormat = upper(header?.format) || 'TEXT';
  return {
    wabaId: t.wabaId,
    name: `${t.name}_copy`.slice(0, 512),
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
