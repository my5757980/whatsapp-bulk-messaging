import { attributeText } from '../conversations/visibility.js';

// Saved-reply text with variables and numbered parameters (T061, FR-030, FR-031). Pure.
//   {first_name} {last_name} {name} {phone} {attr:<key>}  - contact values, each with an optional fallback
//   {{1}} ... {{n}}                                     - parameters the member fills in before sending
// WhatsApp formatting is left as written; unknown placeholders are left untouched.

export interface CannedContact {
  name: string | null;
  phoneE164: string | null;
  attributes: Record<string, unknown>;
}

export type RenderResult = { ok: true; text: string } | { ok: false; missing: string[] };

const VARIABLE = /\{(first_name|last_name|name|phone|attr:[A-Za-z0-9_]+)\}/g;
const PARAMETER = /\{\{(\d{1,2})\}\}/g;

/** The highest parameter number used, i.e. how many parameters the member must fill in. */
export function parameterCount(text: string): number {
  let max = 0;
  for (const match of text.matchAll(PARAMETER)) max = Math.max(max, Number(match[1]));
  return max;
}

export function renderCanned(
  text: string,
  contact: CannedContact,
  fallbacks: Record<string, string> = {},
  params: Record<string, string> = {},
): RenderResult {
  const count = parameterCount(text);
  const missing: string[] = [];
  for (let n = 1; n <= count; n++) if (!params[String(n)]?.trim()) missing.push(String(n));
  if (missing.length) return { ok: false, missing };

  const [first, ...rest] = (contact.name ?? '').trim().split(/\s+/).filter(Boolean);
  const value = (key: string): string | null => {
    switch (key) {
      case 'first_name':
        return first ?? null;
      case 'last_name':
        return rest.length ? rest.join(' ') : null;
      case 'name':
        return contact.name?.trim() || null;
      case 'phone':
        return contact.phoneE164;
      default:
        return attributeText(contact.attributes[key.slice('attr:'.length)]);
    }
  };
  const filled = text
    .replace(VARIABLE, (_match, key: string) => value(key) ?? fallbacks[key] ?? '')
    .replace(PARAMETER, (_match, n: string) => params[n]!.trim());
  return { ok: true, text: filled };
}
