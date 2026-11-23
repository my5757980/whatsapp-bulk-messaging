import { Injectable } from '@nestjs/common';
import { AI_LIMITS } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { KnowledgeItem } from '../claude/prompt.js';

// Knowledge search over chunks with Postgres full-text search (research R4, T039): the generated
// tsvector (English and simple configurations, titles weighted), words joined with OR, written
// answers first on ties; only enabled, ready sources.

const STOP_WORDS = new Set(
  'a about again all also am an and any are as at be been being but by can could did do does each few for from get had has have hello here hi how i if in into is it its just many may me might more most much must my no not of on only or other our out over please shall should so some such than that the their them then there these they this to too up us very was we what when where which who why will with would yes you your'.split(
    ' ',
  ),
);
const MAX_TERMS = 12;

/** A to_tsquery string of the meaningful words, or null. Only letters and digits survive. */
export function buildSearchQuery(text: string): string | null {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...raw].length < 2 || STOP_WORDS.has(raw) || terms.includes(raw)) continue;
    terms.push(raw);
    if (terms.length === MAX_TERMS) break;
  }
  return terms.length ? terms.join(' | ') : null;
}

interface ChunkRow {
  id: string;
  source_id: string;
  kind: 'ANSWER' | 'FILE' | 'WEBSITE';
  title: string;
  heading: string | null;
  text: string;
}

/** How written answers and chunks are named for the model and in AI reply records. */
export function knowledgeId(row: { id: string; source_id: string; kind: string }): string {
  return row.kind === 'ANSWER' ? `src:${row.source_id}` : `chunk:${row.id}`;
}

function toItem(row: ChunkRow): KnowledgeItem {
  return { id: knowledgeId(row), kind: row.kind, title: row.heading ? `${row.title} — ${row.heading}` : row.title, text: row.text };
}

@Injectable()
export class KnowledgeSearch {
  constructor(private readonly prisma: PrismaService) {}

  /** The best chunks for the text, at most `limit` (6 by default). */
  async retrieve(agentId: string, text: string, limit: number = AI_LIMITS.retrievedChunks): Promise<KnowledgeItem[]> {
    const query = buildSearchQuery(text);
    if (!query) return [];
    const rows = await this.prisma.$queryRaw<ChunkRow[]>`
      SELECT c.id, c.source_id, s.kind, c.title, c.heading, c.text
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_sources s ON s.id = c.source_id
       CROSS JOIN (SELECT to_tsquery('english', ${query}) || to_tsquery('simple', ${query}) AS q) query
       WHERE c.agent_id = ${agentId}::uuid AND s.enabled AND s.status = 'READY' AND c.tsv @@ query.q
       ORDER BY ts_rank_cd(c.tsv, query.q) DESC, (s.kind = 'ANSWER') DESC, c.position
       LIMIT ${limit}`;
    return rows.map(toItem);
  }

  /** Enabled, ready knowledge size, to choose whole-knowledge or search mode (research R4). */
  async totalChars(agentId: string): Promise<number> {
    const result = await this.prisma.aiKnowledgeSource.aggregate({ where: { agentId, enabled: true, status: 'READY' }, _sum: { charCount: true } });
    return result._sum.charCount ?? 0;
  }

  /** Every enabled, ready item in priority order (whole mode), or only written answers (search mode). */
  async items(agentId: string, onlyAnswers: boolean): Promise<KnowledgeItem[]> {
    const rows = await this.prisma.$queryRaw<ChunkRow[]>`
      SELECT c.id, c.source_id, s.kind, c.title, c.heading, c.text
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_sources s ON s.id = c.source_id
       WHERE c.agent_id = ${agentId}::uuid AND s.enabled AND s.status = 'READY'
         AND (${onlyAnswers} = false OR s.kind = 'ANSWER')
       ORDER BY CASE s.kind WHEN 'ANSWER' THEN 0 WHEN 'FILE' THEN 1 ELSE 2 END, s.created_at, c.position`;
    return rows.map(toItem);
  }

  /** The `<results>` block a search_knowledge call returns. */
  async searchForTool(agentId: string, query: string, render: (item: KnowledgeItem) => string): Promise<{ text: string; items: KnowledgeItem[] }> {
    const items = await this.retrieve(agentId, query);
    return { text: items.length ? `<results>\n${items.map(render).join('\n')}\n</results>` : '<results>\nNo matching knowledge.\n</results>', items };
  }
}
