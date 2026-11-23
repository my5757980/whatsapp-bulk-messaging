import { randomUUID } from 'node:crypto';
import nock from 'nock';

// Streamed Messages API replies for nock (004 US9): the team assistant streams every turn
// (contracts/claude-messages.md section 6), so its fake replies are server-sent events.
export const CLAUDE = 'https://api.anthropic.com';

export type StreamBlock = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> };

/** One reply as the events of a streamed response: message_start, the blocks, message_delta, message_stop. */
export function streamEvents(blocks: StreamBlock[], usage = { input: 1500, output: 200 }): string {
  const events: Array<[string, unknown]> = [];
  events.push([
    'message_start',
    {
      type: 'message_start',
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ]);
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else {
      const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Queues one streamed reply; each request body is pushed to `seen` when given. */
export function claudeStream(blocks: StreamBlock[], seen?: unknown[]) {
  return nock(CLAUDE)
    .post('/v1/messages', (body: unknown) => {
      seen?.push(body);
      return true;
    })
    .query(true)
    .reply(200, streamEvents(blocks), { 'content-type': 'text/event-stream' });
}

/** The text of the tool results in the last user message of a request body. */
export function toolResultsOf(body: unknown): Array<{ text: string; isError: boolean }> {
  const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const blocks = Array.isArray(last?.content) ? (last.content as Array<Record<string, unknown>>) : [];
  return blocks
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      text: typeof b.content === 'string' ? b.content : ((b.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join(''),
      isError: b.is_error === true,
    }));
}
