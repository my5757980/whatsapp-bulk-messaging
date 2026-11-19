import { parse as parseSync } from 'csv-parse/sync';
import { AppError } from '../../common/errors/app-error.js';

// CSV helpers for uploads (research R13): UTF-8 with optional BOM; the delimiter is detected
// from the header line among comma, semicolon and tab.

export type Delimiter = ',' | ';' | '\t';

const CANDIDATES: Delimiter[] = [',', ';', '\t'];

export function detectDelimiter(headerLine: string): Delimiter {
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export interface CsvHeader {
  delimiter: Delimiter;
  columns: string[];
}

/** Reads the header row from the start of an uploaded file; rejects empty or malformed headers. */
export function readCsvHeader(file: Buffer): CsvHeader {
  const raw = file.subarray(0, 64 * 1024).toString('utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 BOM
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.trim()) throw AppError.validation('The file is empty or has no header row', [{ field: 'file', issue: 'needs a header row' }]);
  const delimiter = detectDelimiter(firstLine);
  let rows: string[][];
  try {
    rows = parseSync(firstLine, { delimiter, relax_quotes: true }) as string[][];
  } catch {
    throw AppError.validation('The header row could not be read', [{ field: 'file', issue: 'is not a valid CSV file' }]);
  }
  const columns = (rows[0] ?? []).map((c, i) => c.trim() || `column_${i + 1}`);
  const duplicates = columns.filter((c, i) => columns.indexOf(c) !== i);
  if (duplicates.length) {
    throw AppError.validation('Column names must be unique', [{ field: 'file', issue: `duplicate columns: ${[...new Set(duplicates)].join(', ')}` }]);
  }
  return { delimiter, columns };
}

/** Escapes one CSV field (RFC 4180) and neutralises spreadsheet formulas. */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d[\d.]*$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
