import { Injectable } from '@nestjs/common';
import { costMicros, dayKey, DEFAULT_AI_PRICES, monthKey, type AiPrices, type TokenUsage } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

export type UsageKind = 'REPLY' | 'PREVIEW' | 'ASSISTANT';

/** Settings the usage maths needs, read fresh for every turn. */
export interface UsageSettings {
  timezone: string;
  prices: AiPrices;
  replyLimit: number;
  assistantLimit: number;
  limitMessage: string | null;
}

function pricesOf(value: unknown): AiPrices {
  const v = (value ?? {}) as Partial<AiPrices>;
  const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fallback);
  return {
    model: typeof v.model === 'string' ? v.model : DEFAULT_AI_PRICES.model,
    input: num(v.input, DEFAULT_AI_PRICES.input),
    output: num(v.output, DEFAULT_AI_PRICES.output),
    cacheRead: num(v.cacheRead, DEFAULT_AI_PRICES.cacheRead),
    cacheWrite: num(v.cacheWrite, DEFAULT_AI_PRICES.cacheWrite),
  };
}

/**
 * AI usage counting (research R10, FR-036): daily rows per kind, agent, number and test flag, and the
 * month's running total. US7 adds the atomic limit and the alerts on top of recordReply.
 */
@Injectable()
export class AiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async settings(): Promise<UsageSettings> {
    const row = await this.prisma.settings.findUnique({
      where: { id: 1 },
      select: { defaultTimezone: true, aiPrices: true, aiReplyLimit: true, aiAssistantLimit: true, aiLimitMessage: true },
    });
    return {
      timezone: row?.defaultTimezone ?? 'UTC',
      prices: pricesOf(row?.aiPrices),
      replyLimit: row?.aiReplyLimit ?? 1000,
      assistantLimit: row?.aiAssistantLimit ?? 300,
      limitMessage: row?.aiLimitMessage ?? null,
    };
  }

  cost(usage: TokenUsage, settings: UsageSettings): number {
    return costMicros(usage, settings.prices);
  }

  /** Adds one counted use to the day's row (and, for AI replies, the month's total). */
  async record(
    tx: Tx,
    input: { kind: UsageKind; agentId: string | null; numberId: string | null; test: boolean; usage: TokenUsage; costMicros: number; at: Date; timezone: string; countsAgainstMonth: boolean },
  ): Promise<void> {
    const day = dayKey(input.at, input.timezone);
    await tx.$executeRaw`
      INSERT INTO ai_usage_daily (id, day, kind, agent_id, number_id, test, count, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micros)
      VALUES (gen_random_uuid(), ${day}::date, ${input.kind}::"AiUsageKind", ${input.agentId}::uuid, ${input.numberId}::uuid, ${input.test}, 1,
              ${input.usage.inputTokens}, ${input.usage.cacheReadTokens}, ${input.usage.cacheWriteTokens}, ${input.usage.outputTokens}, ${input.costMicros})
      ON CONFLICT (day, kind, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(number_id, '00000000-0000-0000-0000-000000000000'::uuid), test)
      DO UPDATE SET count = ai_usage_daily.count + 1,
                    input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
                    cache_read_tokens = ai_usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
                    cache_write_tokens = ai_usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
                    output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
                    cost_micros = ai_usage_daily.cost_micros + EXCLUDED.cost_micros`;
    if (!input.countsAgainstMonth) return;
    const month = monthKey(input.at, input.timezone);
    if (input.kind === 'ASSISTANT') {
      await tx.$executeRaw`
        INSERT INTO ai_usage_months (month, assistant_requests) VALUES (${month}::date, 1)
        ON CONFLICT (month) DO UPDATE SET assistant_requests = ai_usage_months.assistant_requests + 1`;
    } else {
      await tx.$executeRaw`
        INSERT INTO ai_usage_months (month, replies) VALUES (${month}::date, 1)
        ON CONFLICT (month) DO UPDATE SET replies = ai_usage_months.replies + 1`;
    }
  }
}
