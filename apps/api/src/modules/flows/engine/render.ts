import { renderCanned, type CannedContact } from '../../inbox/canned/canned-render.js';

// Variables in flow texts (003 research R9): the 002 saved-reply syntax (`{first_name}`,
// `{last_name}`, `{name}`, `{phone}`, `{attr:key}`) plus `{answer:name}`, each with an optional
// fallback from the step. Contact values are filled first, so text a customer typed into an answer is
// never treated as a placeholder. A missing value without a fallback renders as empty (FR-017).

const ANSWER = /\{answer:([a-z][a-z0-9_]{0,39})\}/g;

function answerText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function renderFlowText(text: string, contact: CannedContact, fallbacks: Record<string, string>, answers: Record<string, unknown>): string {
  const contactFilled = renderCanned(text, contact, fallbacks);
  // Flows have no member-filled {{n}} parameters; leave such text as written.
  const base = contactFilled.ok ? contactFilled.text : text;
  return base.replace(ANSWER, (_match, name: string) => answerText(answers[name]) || fallbacks[`answer:${name}`] || '');
}
