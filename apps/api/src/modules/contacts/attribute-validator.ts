// Typed custom attribute values (FR-011, T121). Values are stored in contacts.attributes as
// JSON: TEXT -> string, NUMBER -> number, DATE -> "YYYY-MM-DD", BOOLEAN -> boolean.

export type AttributeType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN';
export type AttributeValue = string | number | boolean;
export type AttributeValidation = { ok: true; value: AttributeValue } | { ok: false; issue: string };

const MAX_TEXT = 500;
const TRUE_VALUES = new Set(['true', 'yes', 'y', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function validateAttributeValue(type: AttributeType, raw: unknown): AttributeValidation {
  switch (type) {
    case 'TEXT': {
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return { ok: false, issue: 'must be text' };
      const text = String(raw).trim();
      return text.length > MAX_TEXT ? { ok: false, issue: `must be at most ${MAX_TEXT} characters` } : { ok: true, value: text };
    }
    case 'NUMBER': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, issue: 'must be a number' };
      if (typeof raw === 'string') {
        const cleaned = raw.trim().replace(/,/g, '');
        if (/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: true, value: Number(cleaned) };
      }
      return { ok: false, issue: 'must be a number' };
    }
    case 'DATE': {
      const m = typeof raw === 'string' ? DATE_PATTERN.exec(raw.trim()) : null;
      if (m) {
        const [, y, mo, d] = m as unknown as [string, string, string, string];
        const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
        if (date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d)) {
          return { ok: true, value: `${y}-${mo}-${d}` };
        }
      }
      return { ok: false, issue: 'must be a date in YYYY-MM-DD format' };
    }
    case 'BOOLEAN': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim().toLowerCase() : '';
      if (TRUE_VALUES.has(text)) return { ok: true, value: true };
      if (FALSE_VALUES.has(text)) return { ok: true, value: false };
      return { ok: false, issue: 'must be yes or no' };
    }
  }
}

/** True for values that mean "not provided" (left unchanged on import). */
export function isBlank(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}
