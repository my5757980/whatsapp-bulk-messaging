import type { TextBlock } from '@wbm/shared';
import mammoth from 'mammoth';
import { KnowledgeError } from './errors.js';
import { htmlBlocks } from './html.js';

// Word (DOCX) text with mammoth, research R11: converted to HTML first so headings survive.

export async function extractDocx(data: Buffer): Promise<TextBlock[]> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: data })).value;
  } catch {
    throw new KnowledgeError('UNREADABLE');
  }
  const { blocks } = htmlBlocks(`<html><body><main>${html}</main></body></html>`);
  if (!blocks.some((b) => b.kind === 'paragraph')) throw new KnowledgeError('NO_TEXT');
  return blocks;
}
