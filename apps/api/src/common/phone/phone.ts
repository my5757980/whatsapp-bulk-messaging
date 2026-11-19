import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export interface NormalizedPhone {
  /** E.164, e.g. "+971501234567" */
  e164: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
}

/**
 * Normalises user input to E.164 (research R13). National numbers use the company's default
 * country. Returns null when the number is not valid for any region.
 */
export function normalizePhone(input: string, defaultCountry: string): NormalizedPhone | null {
  let candidate = input.trim().replace(/[\s().-]/g, '');
  if (!candidate) return null;
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  const parsed = parsePhoneNumberFromString(candidate, defaultCountry.toUpperCase() as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country ?? defaultCountry.toUpperCase() };
}

/** Meta expects recipient numbers as digits without "+". */
export function e164ToWaRecipient(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** Webhook `from` / `recipient_id` values are digits without "+". */
export function waIdToE164(waId: string): string {
  return waId.startsWith('+') ? waId : `+${waId}`;
}

/** Masks to the last 4 digits (constitution Principles III and VI). */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return `•••• ${digits.slice(-4)}`;
}
