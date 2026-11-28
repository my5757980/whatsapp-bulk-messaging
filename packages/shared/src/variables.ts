// Template variable keys (BODY.n, HEADER.n, BUTTON.i.n) and extraction from Meta template
// components. Keys are used by campaign variable mapping and the public API `params`.

export type VariableComponent = 'HEADER' | 'BODY' | 'BUTTON';

export interface VariableRef {
  component: VariableComponent;
  /** Button position (BUTTON keys only). */
  index?: number;
  /** "1", "2", ... for positional templates, or a parameter name for named templates. */
  placeholder: string;
}

export interface TemplateVariable {
  key: string;
  example: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const KEY = /^(HEADER|BODY)\.([A-Za-z0-9_]+)$|^BUTTON\.(\d+)\.([A-Za-z0-9_]+)$/;

export function formatVariableKey(ref: VariableRef): string {
  return ref.component === 'BUTTON'
    ? `BUTTON.${ref.index ?? 0}.${ref.placeholder}`
    : `${ref.component}.${ref.placeholder}`;
}

export function parseVariableKey(key: string): VariableRef | null {
  const m = KEY.exec(key);
  if (!m) return null;
  if (m[1] && m[2]) return { component: m[1] as 'HEADER' | 'BODY', placeholder: m[2] };
  if (m[3] && m[4]) return { component: 'BUTTON', index: Number(m[3]), placeholder: m[4] };
  return null;
}

function placeholdersIn(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').filter(Boolean);
}

/** Minimal shape of a Meta template component as returned by the Graph API. */
export interface MetaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_text_named_params?: Array<{ param_name: string; example: string }>;
    body_text_named_params?: Array<{ param_name: string; example: string }>;
  };
  buttons?: Array<{ type: string; text?: string; url?: string; example?: string[] }>;
  /** Feature 009: carousel cards, each with its own header, body and buttons. */
  cards?: Array<{ components?: MetaTemplateComponent[] }>;
}

function examplesFor(
  placeholders: string[],
  positional: string[] | undefined,
  named: Array<{ param_name: string; example: string }> | undefined,
): string[] {
  return placeholders.map((p, i) => {
    const byName = named?.find((n) => n.param_name === p)?.example;
    return byName ?? positional?.[i] ?? '';
  });
}

/** Lists every variable of a template in display order with its sample value. */
export function extractTemplateVariables(components: MetaTemplateComponent[]): TemplateVariable[] {
  const result: TemplateVariable[] = [];
  for (const component of components) {
    const type = component.type.toUpperCase();
    if (type === 'HEADER' && (component.format ?? 'TEXT').toUpperCase() === 'TEXT') {
      const names = placeholdersIn(component.text);
      const examples = examplesFor(names, component.example?.header_text, component.example?.header_text_named_params);
      names.forEach((p, i) => result.push({ key: formatVariableKey({ component: 'HEADER', placeholder: p }), example: examples[i] ?? '' }));
    } else if (type === 'BODY') {
      const names = placeholdersIn(component.text);
      const examples = examplesFor(names, component.example?.body_text?.[0], component.example?.body_text_named_params);
      names.forEach((p, i) => result.push({ key: formatVariableKey({ component: 'BODY', placeholder: p }), example: examples[i] ?? '' }));
    } else if (type === 'BUTTONS') {
      (component.buttons ?? []).forEach((button, index) => {
        if (button.type.toUpperCase() !== 'URL') return;
        placeholdersIn(button.url).forEach((p, i) =>
          result.push({ key: formatVariableKey({ component: 'BUTTON', index, placeholder: p }), example: button.example?.[i] ?? '' }),
        );
      });
    } else if (type === 'CAROUSEL') {
      // Feature 009 (research R6): CARD.c.BODY.n and CARD.c.BUTTON.b.n, zero-based card and button.
      (component.cards ?? []).forEach((card, c) => {
        for (const part of card.components ?? []) {
          const partType = part.type.toUpperCase();
          if (partType === 'BODY') {
            const names = placeholdersIn(part.text);
            const examples = examplesFor(names, part.example?.body_text?.[0], part.example?.body_text_named_params);
            names.forEach((p, i) => result.push({ key: `CARD.${c}.BODY.${p}`, example: examples[i] ?? '' }));
          } else if (partType === 'BUTTONS') {
            (part.buttons ?? []).forEach((button, b) => {
              if (button.type.toUpperCase() !== 'URL') return;
              placeholdersIn(button.url).forEach((p, i) => result.push({ key: `CARD.${c}.BUTTON.${b}.${p}`, example: button.example?.[i] ?? '' }));
            });
          }
        }
      });
    }
  }
  return result;
}
