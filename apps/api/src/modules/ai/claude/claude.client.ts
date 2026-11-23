import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import { Inject, Injectable } from '@nestjs/common';
import { addUsage, NO_USAGE, type TokenUsage } from '@wbm/shared';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';

// The only outbound AI call (specs/004-ai-agent/contracts/claude-messages.md, research R1–R3, T017).
// A bounded tool loop on the Messages API with the server-side refusal fallback, a deadline, summed
// token usage and typed failures. Threads are off, so every call carries the full history and
// nothing is held at the provider between calls (research R2).

export type ClaudeFailureReason = 'TIMEOUT' | 'REFUSAL' | 'INVALID_OUTPUT' | 'AUTH' | 'UNAVAILABLE';

export class ClaudeFailure extends Error {
  constructor(
    readonly reason: ClaudeFailureReason,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ClaudeFailure';
  }
}

/** A tool the model may call; `run` returns the text of the tool result. */
export interface ClaudeTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  run: (input: Record<string, unknown>) => Promise<string>;
}

export interface TurnRequest {
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Array<Anthropic.Beta.BetaMessageParam | Anthropic.Beta.BetaSystemMessageParam>;
  tools: ClaudeTool[];
  effort: 'low' | 'medium';
  /** JSON schema for the final answer (structured output); omitted for plain-text answers. */
  schema?: Record<string, unknown>;
  deadlineMs: number;
  maxIterations: number;
  maxTokens?: number;
  /** Streams each turn (long answers such as the team assistant's drafts), so no HTTP timeout cuts them off. */
  stream?: boolean;
}

export interface TurnResult {
  /** The final answer's text (JSON when a schema was given). */
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason: string;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function usageOf(message: Anthropic.Beta.BetaMessage): TokenUsage {
  const usage = message.usage;
  return {
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

@Injectable()
export class ClaudeClient {
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.model = config.AI_MODEL || 'claude-opus-5-5';
    const apiKey = config.ANTHROPIC_API_KEY;
    const baseURL = config.ANTHROPIC_BASE_URL;
    // Without a key or a fake-model address, agents fail closed to their fallback message.
    this.client =
      apiKey || baseURL
        ? new Anthropic({ apiKey: apiKey ?? 'fake-model', ...(baseURL ? { baseURL } : {}), timeout: 25_000, maxRetries: 1 })
        : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (!this.client) throw new ClaudeFailure('AUTH', 'No AI service is configured (ANTHROPIC_API_KEY)');
    const params: BetaToolRunnerParams = {
      model: this.model,
      max_tokens: request.maxTokens ?? 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: {
        effort: request.effort,
        ...(request.schema ? { format: { type: 'json_schema' as const, schema: request.schema } } : {}),
      },
      system: request.system,
      tools: request.tools.map((tool) => ({
        ...betaTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          run: (input: unknown) => tool.run(input as Record<string, unknown>),
        }),
        strict: true,
      })),
      messages: request.messages as Anthropic.Beta.BetaMessageParam[],
      max_iterations: request.maxIterations,
      thread: false,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.deadlineMs);
    try {
      let usage = NO_USAGE;
      let last: Anthropic.Beta.BetaMessage | undefined;
      if (request.stream) {
        for await (const stream of this.client.beta.messages.toolRunner({ ...params, stream: true }, { signal: controller.signal })) {
          last = await stream.finalMessage();
          usage = addUsage(usage, usageOf(last));
        }
      } else {
        for await (const message of this.client.beta.messages.toolRunner({ ...params, stream: false }, { signal: controller.signal })) {
          last = message;
          usage = addUsage(usage, usageOf(last));
        }
      }
      if (!last) throw new ClaudeFailure('INVALID_OUTPUT', 'The AI service returned no answer');
      if (last.stop_reason === 'refusal') throw new ClaudeFailure('REFUSAL', 'The AI service declined to answer');
      if (last.stop_reason === 'max_tokens') throw new ClaudeFailure('INVALID_OUTPUT', 'The answer was cut off');
      const text = last.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
      if (!text) throw new ClaudeFailure('INVALID_OUTPUT', `The answer had no text (stop reason ${last.stop_reason ?? 'none'})`);
      return { text, usage, model: last.model ?? this.model, stopReason: last.stop_reason ?? 'end_turn' };
    } catch (error) {
      throw this.toFailure(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  private toFailure(error: unknown, aborted: boolean): ClaudeFailure {
    if (error instanceof ClaudeFailure) return error;
    if (aborted || error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) {
      return new ClaudeFailure('TIMEOUT', 'The AI service did not answer in time');
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new ClaudeFailure('AUTH', 'The AI service refused the API key', error.status, error.requestID ?? undefined);
    }
    if (error instanceof Anthropic.APIError) {
      return new ClaudeFailure('UNAVAILABLE', `The AI service failed (HTTP ${error.status ?? 'network'})`, error.status ?? undefined, error.requestID ?? undefined);
    }
    return new ClaudeFailure('UNAVAILABLE', error instanceof Error ? error.message : 'The AI service failed');
  }
}
