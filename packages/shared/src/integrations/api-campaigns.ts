// API campaign rules (feature 006 US3, FR-017 - FR-020, research R6): the stable API name, where each
// template variable gets its text, attribute values set on the contact, and the daily limit's day.

/** Lower-case letters, digits and dashes; 3 to 60 characters; no dash at either end. */
export const API_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
/** Names of the values a call sends, e.g. `order` or `product_name`. */
export const VALUE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const API_CAMPAIGN_MAX_TAGS = 10;
export const API_CAMPAIGN_DAILY_LIMIT_MAX = 100_000;

export type VariableSource = { source: 'value'; key: string } | { source: 'field'; key: string } | { source: 'static'; value: string };
export type ApiVariableMapping = Record<string, VariableSource>;

/** Contact fields a variable can use: the name, the phone, or an attribute as `attributes.<key>`. */
export const CONTACT_FIELD_KEYS = ['name', 'phone'] as const;
export const ATTRIBUTE_FIELD_PREFIX = 'attributes.';

export interface ContactFacts {
  name: string | null;
  phone: string;
  attributes: Record<string, unknown>;
}

export type ApiResolveResult =
  | { ok: true; params: Record<string, string> }
  /** `missing` is the call value's name, the contact field, or the variable when it has no source. */
  | { ok: false; variable: string; missing: string; from: 'value' | 'field' | 'mapping' };

export function apiNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 60) return 'must be 3 to 60 characters';
  if (!API_NAME_PATTERN.test(name)) return 'use lower-case letters, digits and dashes, starting and ending with a letter or digit';
  return null;
}

/** A suggested API name, e.g. "Order feedback" becomes "order-feedback". */
export function suggestApiName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (slug.length >= 3) return slug;
  return slug ? `${slug}-campaign` : 'campaign';
}

export function isContactField(key: string): boolean {
  return (CONTACT_FIELD_KEYS as readonly string[]).includes(key) || (key.startsWith(ATTRIBUTE_FIELD_PREFIX) && key.length > ATTRIBUTE_FIELD_PREFIX.length);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function fieldText(key: string, contact: ContactFacts): string {
  if (key === 'name') return asText(contact.name);
  if (key === 'phone') return asText(contact.phone);
  if (key.startsWith(ATTRIBUTE_FIELD_PREFIX)) return asText(contact.attributes[key.slice(ATTRIBUTE_FIELD_PREFIX.length)]);
  return '';
}

/** Every template variable's text for one call (FR-019); the first one without text is named. */
export function resolveApiValues(variableKeys: readonly string[], mapping: ApiVariableMapping, values: Record<string, string>, contact: ContactFacts): ApiResolveResult {
  const params: Record<string, string> = {};
  for (const variable of variableKeys) {
    const source = mapping[variable];
    if (!source) return { ok: false, variable, missing: variable, from: 'mapping' };
    if (source.source === 'static') {
      params[variable] = source.value.trim();
      continue;
    }
    const text = source.source === 'value' ? asText(values[source.key]) : fieldText(source.key, contact);
    if (!text) return { ok: false, variable, missing: source.key, from: source.source };
    params[variable] = text;
  }
  return { ok: true, params };
}

/** What keeps a campaign from going live: variables without a usable source, and unknown ones (FR-017). */
export function mappingProblems(variableKeys: readonly string[], mapping: ApiVariableMapping): string[] {
  const problems: string[] = [];
  for (const variable of variableKeys) {
    const source = mapping[variable];
    if (!source) problems.push(`${variable} has no value source`);
    else if (source.source === 'value' && !VALUE_KEY_PATTERN.test(source.key)) problems.push(`${variable}: "${source.key}" is not a valid value name (lower-case letters, digits and _)`);
    else if (source.source === 'field' && !isContactField(source.key)) problems.push(`${variable}: "${source.key}" is not a contact field`);
    else if (source.source === 'static' && !source.value.trim()) problems.push(`${variable} has empty fixed text`);
  }
  for (const variable of Object.keys(mapping)) if (!variableKeys.includes(variable)) problems.push(`${variable} is not a variable of this template`);
  return problems;
}

const fromValueOf = (spec: unknown): string | null => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const from = (spec as { fromValue?: unknown }).fromValue;
  return typeof from === 'string' ? from : null;
};

/** Attribute values set on the contact: fixed values, or `{ fromValue: key }` read from the call (left out when the call has none). */
export function resolveAttributeValues(attributes: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(attributes)) {
    const from = fromValueOf(spec);
    if (from !== null) {
      const text = asText(values[from]);
      if (text) out[key] = text;
    } else if (spec !== null && spec !== undefined && spec !== '') {
      out[key] = spec;
    }
  }
  return out;
}

/** The value names a call can send, for the ready-made request (sorted). */
export function callValueKeys(mapping: ApiVariableMapping, attributes: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const source of Object.values(mapping)) if (source.source === 'value') keys.add(source.key);
  for (const spec of Object.values(attributes)) {
    const from = fromValueOf(spec);
    if (from) keys.add(from);
  }
  return [...keys].sort();
}

/** Midnight of the local day containing `at` in `timeZone`: the daily limit counts from here (FR-020). */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const wall = (d: Date) => {
    const p = Object.fromEntries(format.formatToParts(d).map((x) => [x.type, x.value]));
    return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
  };
  // The zone's offset at an instant: its wall time read as UTC, minus the instant (whole seconds).
  const offsetAt = (d: Date) => {
    const w = wall(d);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(d.getTime() / 1000) * 1000;
  };
  const local = wall(at);
  const midnightAsUtc = Date.UTC(local.y, local.m - 1, local.d);
  const first = midnightAsUtc - offsetAt(at);
  // When the clocks changed between midnight and `at`, use the offset in force at midnight.
  return new Date(midnightAsUtc - offsetAt(new Date(first)));
}
