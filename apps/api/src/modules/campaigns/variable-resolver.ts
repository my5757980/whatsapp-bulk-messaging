import { z } from 'zod';

// Campaign variable mapping (contract `VariableMapping`, FR-020/FR-021, T094).

export const VariableSourceSchema = z
  .object({
    // Feature 008: `payment` reads the payment request a message carries (key: amount, description,
    // reference, expires, link or code).
    source: z.enum(['column', 'field', 'attribute', 'static', 'payment']),
    key: z.string().trim().min(1).max(100).optional(),
    value: z.string().max(1024).optional(),
    fallback: z.string().max(1024).nullish(),
  })
  .refine((m) => (m.source === 'static' ? m.value !== undefined : Boolean(m.key)), {
    message: 'static sources need a value; other sources need a key',
  });
export type VariableSource = z.infer<typeof VariableSourceSchema>;

export const VariableMappingSchema = z.record(z.string(), VariableSourceSchema);
export type VariableMapping = z.infer<typeof VariableMappingSchema>;

/** Contact fields that can feed a variable (`field` source). */
export const CONTACT_FIELDS = ['name', 'phone'] as const;

export interface ResolveInput {
  contact: { name: string | null; phone: string | null; attributes: unknown };
  /** Raw CSV columns of the uploaded row (`column` source); empty for non-upload audiences. */
  row: Record<string, unknown>;
  /** The payment request the message carries (`payment` source, feature 008), already formatted. */
  payment?: PaymentVariables;
}

export const PAYMENT_VARIABLE_KEYS = ['amount', 'description', 'reference', 'expires', 'link', 'code'] as const;
export type PaymentVariables = Partial<Record<(typeof PAYMENT_VARIABLE_KEYS)[number], string>>;

export type ResolveResult = { ok: true; params: Record<string, string> } | { ok: false; missing: string[] };

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function readSource(source: VariableSource, input: ResolveInput): string {
  switch (source.source) {
    case 'static':
      return asText(source.value);
    case 'column':
      return asText(input.row[source.key ?? '']);
    case 'field':
      if (source.key === 'name') return asText(input.contact.name);
      if (source.key === 'phone') return asText(input.contact.phone);
      return '';
    case 'payment':
      return asText(input.payment?.[(source.key ?? '') as keyof PaymentVariables]);
    case 'attribute': {
      const attributes = input.contact.attributes;
      return attributes && typeof attributes === 'object'
        ? asText((attributes as Record<string, unknown>)[source.key ?? ''])
        : '';
    }
  }
}

/**
 * Resolves every template variable for one recipient. Empty values use the fallback; a variable
 * with neither a value nor a fallback is reported as missing (recipient skipped MISSING_VARIABLE).
 */
export function resolveVariables(
  variables: ReadonlyArray<{ key: string; example?: string }>,
  mapping: VariableMapping,
  input: ResolveInput,
): ResolveResult {
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const { key } of variables) {
    const source = mapping[key];
    const value = source ? readSource(source, input) : '';
    const fallback = source?.fallback?.trim() ?? '';
    if (value) params[key] = value;
    else if (fallback) params[key] = fallback;
    else missing.push(key);
  }
  return missing.length ? { ok: false, missing } : { ok: true, params };
}

/** Variable keys without a usable mapping (launch validation). */
export function unmappedVariables(variables: ReadonlyArray<{ key: string; example?: string }>, mapping: VariableMapping): string[] {
  return variables.filter(({ key }) => !mapping[key]).map(({ key }) => key);
}

/** Renders the body text with resolved `BODY.*` values for previews. */
export function renderBodyPreview(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) => params[`BODY.${name}`] ?? match);
}
