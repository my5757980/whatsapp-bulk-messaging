import type { TextBlock } from '@wbm/shared';
import * as cheerio from 'cheerio';

// Web page and DOCX (via HTML) text with cheerio, research R11: scripts, styles, navigation, headers,
// footers and side panels are dropped; `main` or `article` is preferred; h1–h3 become headings.

const REMOVED = 'script, style, noscript, template, svg, canvas, iframe, nav, header, footer, aside, form, button, select, [hidden], [aria-hidden="true"]';
const TEXT_TAGS = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th, dd, dt, figcaption';
const HEADING = /^h([1-3])$/;

export interface HtmlPage {
  title: string | null;
  blocks: TextBlock[];
  /** Every link target on the page (navigation included), for the website reader. */
  links: string[];
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function htmlBlocks(html: string): HtmlPage {
  const $ = cheerio.load(html);
  const title = squash($('title').first().text()) || null;
  const links = $('a[href]')
    .map((_, a) => $(a).attr('href') ?? '')
    .get()
    .filter(Boolean);

  $(REMOVED).remove();
  const root = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body').first();

  const blocks: TextBlock[] = [];
  root.find(TEXT_TAGS).each((_, element) => {
    const node = $(element);
    // A list item holding a paragraph is read through that paragraph, once.
    if (node.find(TEXT_TAGS).length > 0) return;
    const text = squash(node.text());
    if (!text) return;
    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const heading = HEADING.exec(tag);
    blocks.push(heading ? { kind: 'heading', level: Number(heading[1]), text } : { kind: 'paragraph', text });
  });

  if (!blocks.some((b) => b.kind === 'paragraph')) {
    root.find('br').replaceWith('\n');
    root.find('div, section').each((_, element) => {
      $(element).append('\n');
    });
    for (const line of root.text().split('\n')) {
      const text = squash(line);
      if (text) blocks.push({ kind: 'paragraph', text });
    }
  }

  return { title, blocks, links };
}
