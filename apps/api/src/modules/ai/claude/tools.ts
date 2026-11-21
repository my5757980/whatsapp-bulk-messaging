import type { ClaudeTool } from './claude.client.js';

// Tools the model may call during a turn (contracts/claude-messages.md §3, T041). They only gather
// information; every lasting effect is a field of the reply JSON, applied by our service (research R3).
// API skill tools arrive with US5.

export interface ToolDependencies {
  /** Runs one knowledge search and returns the `<results>` block for the model. */
  searchKnowledge: (query: string) => Promise<string>;
  skills: ClaudeTool[];
}

export function searchKnowledgeTool(search: ToolDependencies['searchKnowledge']): ClaudeTool {
  return {
    name: 'search_knowledge',
    description:
      'Search the company knowledge (files and website pages) for facts to answer the customer. Call it when the answer may be in knowledge you have not seen, before saying you do not know. Write a short query of key words in the language of the knowledge.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: 'Key words to search for, for example "delivery Sharjah price".' } },
    },
    run: async (input) => search(typeof input.query === 'string' ? input.query : ''),
  };
}

/** The tools of one turn, sorted by name so the cached prefix stays the same (research R7). */
export function buildTools(dependencies: ToolDependencies): ClaudeTool[] {
  return [searchKnowledgeTool(dependencies.searchKnowledge), ...dependencies.skills].sort((a, b) => a.name.localeCompare(b.name));
}
