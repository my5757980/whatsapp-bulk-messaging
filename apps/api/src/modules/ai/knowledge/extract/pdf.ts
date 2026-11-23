import { AI_LIMITS, type TextBlock } from '@wbm/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { KnowledgeError } from './errors.js';

// PDF text per page with unpdf (pdf.js), research R11. A PDF without a text layer (a scan) or with a
// password is refused with a reason; so is one over the page limit.

function isPasswordError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'PasswordException';
}

/** Lines become paragraphs; a line that does not end a sentence continues into the next one. */
function paragraphsOf(pageText: string): string[] {
  const lines = pageText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  let current = '';
  for (const line of lines) {
    current = current ? `${current} ${line}` : line;
    if (/[.!?:;)”"]$/.test(line)) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export async function extractPdf(data: Uint8Array): Promise<TextBlock[]> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // pdf.js may take over the buffer, so it gets its own copy.
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (error) {
    throw new KnowledgeError(isPasswordError(error) ? 'PASSWORD_PROTECTED' : 'UNREADABLE');
  }
  try {
    if (pdf.numPages > AI_LIMITS.filePages) throw new KnowledgeError('TOO_LARGE');
    const { text } = await extractText(pdf, { mergePages: false });
    const blocks: TextBlock[] = [];
    text.forEach((pageText, index) => {
      for (const paragraph of paragraphsOf(pageText)) blocks.push({ kind: 'paragraph', text: paragraph, page: index + 1 });
    });
    if (blocks.length === 0) throw new KnowledgeError('NO_TEXT');
    return blocks;
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError(isPasswordError(error) ? 'PASSWORD_PROTECTED' : 'UNREADABLE');
  } finally {
    // The serverless pdf.js build has no destroy(); release what the build offers.
    const handle = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    await (handle.destroy ?? handle.cleanup)?.call(pdf).catch(() => undefined);
  }
}
