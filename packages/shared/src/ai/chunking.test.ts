import { describe, expect, it } from 'vitest';
import { answerChunk, chunkBlocks, type TextBlock } from './chunking.js';

// T022: knowledge text becomes chunks of about 1,500 characters with 200 of overlap (research R4).
const sentence = (n: number) => `Sentence number ${n} explains our delivery rules in plain words.`;
const paragraph = (from: number, count: number) => Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

describe('chunkBlocks', () => {
  it('keeps short paragraphs under one heading in one chunk with the heading path', () => {
    const blocks: TextBlock[] = [
      { kind: 'heading', level: 1, text: 'Shipping' },
      { kind: 'heading', level: 2, text: 'Sharjah' },
      { kind: 'paragraph', text: 'Delivery to Sharjah costs AED 50.' },
      { kind: 'paragraph', text: 'It is free on orders over AED 1,000.' },
    ];
    const chunks = chunkBlocks(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ position: 0, heading: 'Shipping › Sharjah', page: null });
    expect(chunks[0]?.text).toBe('Delivery to Sharjah costs AED 50.\n\nIt is free on orders over AED 1,000.');
  });

  it('starts a new chunk at a heading and replaces headings of the same level', () => {
    const chunks = chunkBlocks([
      { kind: 'heading', level: 1, text: 'Shipping' },
      { kind: 'heading', level: 2, text: 'Dubai' },
      { kind: 'paragraph', text: 'Free in Dubai.' },
      { kind: 'heading', level: 2, text: 'Ajman' },
      { kind: 'paragraph', text: 'AED 30 to Ajman.' },
      { kind: 'heading', level: 1, text: 'Returns' },
      { kind: 'paragraph', text: 'Returns within 14 days.' },
    ]);
    expect(chunks.map((c) => c.heading)).toEqual(['Shipping › Dubai', 'Shipping › Ajman', 'Returns']);
    expect(chunks.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it('splits long text near 1,500 characters with about 200 characters of overlap', () => {
    const blocks: TextBlock[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'paragraph' as const, text: paragraph(i * 6, 6) }));
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect([...chunk.text].length).toBeLessThanOrEqual(1500 + 250);
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!.text;
      const overlap = chunks[i]!.text.slice(0, 120);
      expect(previous).toContain(overlap.trim().split(' ').slice(1, 6).join(' '));
    }
  });

  it('never splits inside a word, even in one very long paragraph', () => {
    const long = paragraph(0, 70);
    const chunks = chunkBlocks([{ kind: 'paragraph', text: long }]);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const words = new Set(long.split(/\s+/));
    for (const chunk of chunks) {
      for (const word of chunk.text.split(/\s+/).filter(Boolean)) expect(words.has(word)).toBe(true);
    }
  });

  it('keeps the page number of the first paragraph', () => {
    const chunks = chunkBlocks([
      { kind: 'paragraph', text: 'Page one text.', page: 1 },
      { kind: 'paragraph', text: 'Still page one.', page: 1 },
      { kind: 'heading', level: 1, text: 'Prices' },
      { kind: 'paragraph', text: 'Sofas from AED 2,000.', page: 2 },
    ]);
    expect(chunks.map((c) => c.page)).toEqual([1, 2]);
  });

  it('returns nothing for blocks without text', () => {
    expect(chunkBlocks([{ kind: 'heading', level: 1, text: 'Empty' }, { kind: 'paragraph', text: '   ' }])).toEqual([]);
  });
});

describe('answerChunk', () => {
  it('keeps a written answer as one chunk', () => {
    expect(answerChunk('Do you deliver to Sharjah?', 'Yes, AED 50.')).toEqual({ position: 0, heading: null, page: null, text: 'Q: Do you deliver to Sharjah?\nA: Yes, AED 50.' });
    const long = 'x '.repeat(999).trim();
    expect(answerChunk('Long?', long).text.endsWith(long)).toBe(true);
  });
});
