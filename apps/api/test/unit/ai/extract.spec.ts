import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDocx } from '../../../src/modules/ai/knowledge/extract/docx.js';
import { KnowledgeError } from '../../../src/modules/ai/knowledge/extract/errors.js';
import { htmlBlocks } from '../../../src/modules/ai/knowledge/extract/html.js';
import { extractPdf } from '../../../src/modules/ai/knowledge/extract/pdf.js';

// T023: text extraction for knowledge files and pages (research R11), on fixtures in test/fixtures/ai.
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/ai/${name}`, import.meta.url)));

describe('extractPdf', () => {
  it('returns the text of each page with its page number', async () => {
    const blocks = await extractPdf(new Uint8Array(fixture('text.pdf')));
    const paragraphs = blocks.filter((b) => b.kind === 'paragraph');
    expect(paragraphs.find((b) => b.text.includes('Delivery to Sharjah costs AED 50.'))?.page).toBe(1);
    expect(paragraphs.find((b) => b.text.includes('Sofas start at AED 2,000.'))?.page).toBe(2);
  });

  it('refuses a scanned PDF without a text layer', async () => {
    await expect(extractPdf(new Uint8Array(fixture('scanned.pdf')))).rejects.toMatchObject({ code: 'NO_TEXT' });
  });

  it('refuses a password-protected PDF', async () => {
    await expect(extractPdf(new Uint8Array(fixture('password.pdf')))).rejects.toMatchObject({ code: 'PASSWORD_PROTECTED' });
  });

  it('refuses a PDF over 300 pages', async () => {
    await expect(extractPdf(new Uint8Array(fixture('many-pages.pdf')))).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('refuses bytes that are not a PDF', async () => {
    const error = await extractPdf(new Uint8Array(Buffer.from('not a pdf'))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeError);
    expect((error as KnowledgeError).code).toBe('UNREADABLE');
  });
});

describe('extractDocx', () => {
  it('keeps headings and paragraphs', async () => {
    const blocks = await extractDocx(fixture('returns.docx'));
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Returns' },
      { kind: 'paragraph', text: 'You can return any item within 14 days.' },
      { kind: 'heading', level: 2, text: 'Refunds' },
      { kind: 'paragraph', text: 'Refunds reach your card within 5 working days.' },
    ]);
  });

  it('refuses bytes that are not a DOCX', async () => {
    await expect(extractDocx(Buffer.from('not a docx'))).rejects.toMatchObject({ code: 'UNREADABLE' });
  });
});

describe('htmlBlocks', () => {
  it('reads the main content with h1–h3 headings and drops scripts, styles, navigation, headers and footers', () => {
    const page = htmlBlocks(fixture('delivery.html').toString('utf8'));
    expect(page.title).toBe('Delivery | Example Furniture');
    expect(page.blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Delivery' },
      { kind: 'paragraph', text: 'We deliver across the UAE.' },
      { kind: 'heading', level: 2, text: 'Sharjah' },
      { kind: 'paragraph', text: 'Delivery to Sharjah costs AED 50.' },
      { kind: 'paragraph', text: 'Free on orders over AED 1,000.' },
      { kind: 'paragraph', text: 'Delivery takes 2 to 3 days.' },
      { kind: 'heading', level: 3, text: 'Assembly' },
      { kind: 'paragraph', text: 'Assembly is included.' },
    ]);
    const all = JSON.stringify(page);
    for (const hidden of ['do not read me', 'Menu text', 'Call us today', 'Copyright', 'Related offers', 'Enable JavaScript', 'font-family']) {
      expect(all).not.toContain(hidden);
    }
  });

  it('falls back to the body text when a page has no paragraphs', () => {
    const page = htmlBlocks('<html><head><title>Hours</title></head><body><div>Open 9 to 6, Monday to Saturday.<br>Closed on Sunday.</div></body></html>');
    expect(page.blocks.map((b) => b.text)).toEqual(['Open 9 to 6, Monday to Saturday.', 'Closed on Sunday.']);
  });
});
