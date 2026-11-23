// Knowledge text → searchable chunks (specs/004-ai-agent/research.md R4, T032). Extractors turn files
// and web pages into headings and paragraphs; chunks never span a heading, stay near 1,500
// characters, repeat about 200 characters of the previous chunk, and never cut a word.

export interface TextBlock {
  kind: 'heading' | 'paragraph';
  /** 1–3 for headings. */
  level?: number;
  text: string;
  /** PDF page number, when known. */
  page?: number;
}

export interface Chunk {
  position: number;
  /** Heading path such as "Shipping › Sharjah", or null. */
  heading: string | null;
  page: number | null;
  text: string;
}

export const CHUNK_TARGET = 1500;
export const CHUNK_OVERLAP = 200;

const length = (text: string): number => [...text].length;
const clean = (text: string): string => text.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

/** The last `size` characters of `text`, starting at a word boundary. */
function tail(text: string, size: number): string {
  const chars = [...text];
  if (chars.length <= size) return text;
  const start = chars.length - size;
  const rest = chars.slice(start).join('');
  const space = rest.search(/\s/);
  return (space >= 0 ? rest.slice(space) : rest).trim();
}

/** Splits text longer than `limit` at word boundaries (sentence ends preferred). */
function splitLong(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (length(rest) > limit) {
    const window = [...rest].slice(0, limit).join('');
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    cut = cut > limit * 0.5 ? cut + 1 : window.search(/\s\S*$/);
    if (cut <= 0) cut = window.length;
    pieces.push(window.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function chunkBlocks(blocks: readonly TextBlock[], options: { target?: number; overlap?: number } = {}): Chunk[] {
  const target = options.target ?? CHUNK_TARGET;
  const overlap = options.overlap ?? CHUNK_OVERLAP;
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let parts: string[] = [];
  let size = 0;
  let page: number | null = null;
  let carry = '';

  const heading = () => (path.filter(Boolean).length ? path.filter(Boolean).join(' › ') : null);
  const emit = () => {
    const text = parts.join('\n\n').trim();
    if (text && text !== carry) chunks.push({ position: chunks.length, heading: heading(), page, text });
    carry = text ? tail(text, overlap) : '';
    parts = [];
    size = 0;
    page = null;
  };
  const add = (text: string, blockPage: number | undefined) => {
    if (!parts.length && carry) {
      parts.push(carry);
      size = length(carry);
    }
    if (page === null && blockPage !== undefined) page = blockPage;
    parts.push(text);
    size += length(text) + 2;
  };

  for (const block of blocks) {
    const text = clean(block.text);
    if (block.kind === 'heading') {
      if (parts.length) emit();
      carry = '';
      const level = Math.min(Math.max(block.level ?? 1, 1), 3);
      path.length = level - 1;
      path[level - 1] = text;
      continue;
    }
    if (!text) continue;
    for (const piece of splitLong(text, target - overlap)) {
      if (parts.length && size + length(piece) > target) emit();
      add(piece, block.page);
    }
  }
  if (parts.length) emit();
  return chunks;
}

/** A written answer is always one chunk, so it is never cut apart (FR-013). */
export function answerChunk(question: string, answer: string): Chunk {
  return { position: 0, heading: null, page: null, text: `Q: ${question.trim()}\nA: ${answer.trim()}` };
}
