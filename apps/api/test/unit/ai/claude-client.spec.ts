import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/common/config/config.js';
import { ClaudeClient, ClaudeFailure, type TurnRequest } from '../../../src/modules/ai/claude/claude.client.js';
import { streamEvents } from '../../support/claude-stream.js';

// T016: the only outbound AI call (specs/004-ai-agent/contracts/claude-messages.md §1–§2, §5).
const BASE = 'https://api.anthropic.com';
const config = { ANTHROPIC_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' } as AppConfig;
const client = new ClaudeClient(config);

const schema = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } };

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    system: [
      { type: 'text', text: 'Platform rules' },
      { type: 'text', text: 'Agent instructions', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: 'how much is delivery to Sharjah?' },
      { role: 'system', content: '<turn_context>first reply</turn_context>' },
    ],
    tools: [],
    effort: 'low',
    schema,
    deadlineMs: 5000,
    maxIterations: 4,
    ...overrides,
  };
}

function message(content: unknown[], stopReason: string, usage: Record<string, number> = {}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  };
}

const text = (value: string) => ({ type: 'text', text: value });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('ClaudeClient.runTurn', () => {
  it('sends the model, the fallback, effort and schema, and the full history, without sampling or thread fields', async () => {
    let sent: Record<string, unknown> = {};
    let beta = '';
    nock(BASE)
      .post('/v1/messages')
      .query(true)
      // nock 15 passes the fetch Request to one-argument reply functions.
      .reply(async (req: Request) => {
        sent = (await req.json()) as Record<string, unknown>;
        beta = req.headers.get('anthropic-beta') ?? '';
        return [200, message([text('{"message":"AED 50"}')], 'end_turn')];
      });

    const result = await client.runTurn(request());
    expect(result.text).toBe('{"message":"AED 50"}');
    expect(result.model).toBe('claude-opus-5-5');
    expect(sent.model).toBe('claude-opus-5-5');
    expect(sent.fallbacks).toBe('default');
    expect(beta).toContain('server-side-fallback-2026-07-01');
    expect(sent.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema } });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'thread']) expect(sent).not.toHaveProperty(key);
    expect((sent.system as Array<{ cache_control?: unknown }>)[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect((sent.messages as Array<{ role: string }>).at(-1)?.role).toBe('system');
  });

  it('runs tools, sends their results with the whole conversation, and sums usage over the loop', async () => {
    const bodies: Array<{ messages: Array<{ role: string }> }> = [];
    nock(BASE)
      .post('/v1/messages')
      .query(true)
      .reply(200, async (req: Request) => {
        bodies.push((await req.json()) as never);
        return message([{ type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { query: 'delivery Sharjah' } }], 'tool_use', {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
        });
      })
      .post('/v1/messages')
      .query(true)
      .reply(200, async (req: Request) => {
        bodies.push((await req.json()) as never);
        return message([text('{"message":"AED 50"}')], 'end_turn', { input_tokens: 120, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 5 });
      });

    const calls: unknown[] = [];
    const result = await client.runTurn(
      request({
        tools: [
          {
            name: 'search_knowledge',
            description: 'Search the knowledge',
            inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } },
            run: async (input) => {
              calls.push(input);
              return '<results>Delivery to Sharjah costs AED 50.</results>';
            },
          },
        ],
      }),
    );

    expect(calls).toEqual([{ query: 'delivery Sharjah' }]);
    expect(bodies[1]?.messages.length).toBeGreaterThan(bodies[0]!.messages.length);
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 30, cacheReadTokens: 110, cacheWriteTokens: 5 });
    expect(result.text).toBe('{"message":"AED 50"}');
  });

  it('turns a refusal, a cut-off answer and a missing answer into typed failures', async () => {
    nock(BASE).post('/v1/messages').query(true).reply(200, message([], 'refusal'));
    await expect(client.runTurn(request())).rejects.toMatchObject({ reason: 'REFUSAL' });

    nock(BASE).post('/v1/messages').query(true).reply(200, message([text('{"mess')], 'max_tokens'));
    await expect(client.runTurn(request())).rejects.toMatchObject({ reason: 'INVALID_OUTPUT' });

    nock(BASE).post('/v1/messages').query(true).reply(200, message([], 'end_turn'));
    await expect(client.runTurn(request())).rejects.toBeInstanceOf(ClaudeFailure);
  });

  it('reports a rejected key as AUTH without retrying', async () => {
    const scope = nock(BASE).post('/v1/messages').query(true).once().reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    await expect(client.runTurn(request())).rejects.toMatchObject({ reason: 'AUTH' });
    expect(scope.isDone()).toBe(true);
  });

  it('retries a rate limit once', async () => {
    nock(BASE)
      .post('/v1/messages')
      .query(true)
      .reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after-ms': '10' })
      .post('/v1/messages')
      .query(true)
      .reply(200, message([text('{"message":"ok"}')], 'end_turn'));
    await expect(client.runTurn(request())).resolves.toMatchObject({ text: '{"message":"ok"}' });
  });

  it('gives up at the deadline', async () => {
    // A local server that never answers (a delayed nock reply trips undici after the abort).
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    nock.enableNetConnect('127.0.0.1');
    try {
      const port = (server.address() as AddressInfo).port;
      const slow = new ClaudeClient({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, AI_MODEL: 'claude-opus-5-5' } as AppConfig);
      await expect(slow.runTurn(request({ deadlineMs: 150 }))).rejects.toMatchObject({ reason: 'TIMEOUT' });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      nock.disableNetConnect();
    }
  });

  it('fails closed when neither a key nor a base URL is configured', async () => {
    const unconfigured = new ClaudeClient({ AI_MODEL: 'claude-opus-5-5' } as AppConfig);
    expect(unconfigured.configured).toBe(false);
    await expect(unconfigured.runTurn(request())).rejects.toMatchObject({ reason: 'AUTH' });
  });

  it('streams each turn when asked (the team assistant), still running tools and summing usage', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const keep = (body: Record<string, unknown>) => {
      bodies.push(body);
      return true;
    };
    const sse = { 'content-type': 'text/event-stream' };
    nock(BASE)
      .post('/v1/messages', keep)
      .query(true)
      .reply(200, streamEvents([{ type: 'tool_use', name: 'draft_template', input: { name: 'weekend_sale' } }], { input: 100, output: 20 }), sse);
    nock(BASE)
      .post('/v1/messages', keep)
      .query(true)
      .reply(200, streamEvents([{ type: 'text', text: 'Drafted the template.' }], { input: 150, output: 30 }), sse);
    let ran: unknown = null;
    const result = await client.runTurn(
      request({
        schema: undefined,
        effort: 'medium',
        stream: true,
        maxTokens: 32_000,
        tools: [
          {
            name: 'draft_template',
            description: 'Saves a template draft',
            inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
            run: async (input) => {
              ran = input;
              return 'saved';
            },
          },
        ],
      }),
    );
    expect(ran).toEqual({ name: 'weekend_sale' });
    expect(result.text).toBe('Drafted the template.');
    expect(result.usage).toMatchObject({ inputTokens: 250, outputTokens: 50 });
    expect(bodies.map((b) => b.stream)).toEqual([true, true]);
    expect(bodies[0]).toMatchObject({ max_tokens: 32000, output_config: { effort: 'medium' } });
    expect(JSON.stringify(bodies[1]?.messages)).toContain('saved');
  });
});
