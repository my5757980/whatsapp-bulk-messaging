import { Injectable } from '@nestjs/common';
import { alertLevelFor, costMicros, dayKey, DEFAULT_AI_PRICES, monthKey, type AiPrices, type TokenUsage } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';

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

/** A claimed AI reply of the month, and the alert level it crossed (0 when none). */
export interface ReplyClaim {
  replies: number;
  alert: 0 | 80 | 100;
}

/**
 * AI usage counting (research R10, FR-036–FR-039): daily rows per kind, agent, number and test flag,
 * the month's running total, the monthly reply limit (a cheap check before the model call and an
 * atomic claim when a reply is applied) and the 80% and 100% alerts, once each per month.
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The month's AI replies have reached the limit: no model call is made for a new turn. */
  async replyLimitReached(settings: UsageSettings, at: Date = new Date()): Promise<boolean> {
    if (settings.replyLimit <= 0) return true;
    const month = monthKey(at, settings.timezone);
    const [row] = await this.prisma.$queryRaw<Array<{ replies: number }>>`SELECT replies FROM ai_usage_months WHERE month = ${month}::date`;
    return Number(row?.replies ?? 0) >= settings.replyLimit;
  }

  /** The month's assistant requests have reached their own limit (FR-046): a new request gets 429. */
  async assistantLimitReached(settings: UsageSettings, at: Date = new Date()): Promise<boolean> {
    if (settings.assistantLimit <= 0) return true;
    const month = monthKey(at, settings.timezone);
    const [row] = await this.prisma.$queryRaw<Array<{ assistant_requests: number }>>`SELECT assistant_requests FROM ai_usage_months WHERE month = ${month}::date`;
    return Number(row?.assistant_requests ?? 0) >= settings.assistantLimit;
  }

  /**
   * Claims one AI reply of the month inside the apply transaction (research R10). The guarded update
   * lets exactly as many replies through as the limit allows, however many turns run at once; null
   * means the limit is reached and the reply must not be sent.
   */
  async claimReply(tx: Tx, settings: UsageSettings, at: Date): Promise<ReplyClaim | null> {
    const month = monthKey(at, settings.timezone);
    await tx.$executeRaw`INSERT INTO ai_usage_months (month) VALUES (${month}::date) ON CONFLICT (month) DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ replies: number }>>`
      UPDATE ai_usage_months SET replies = replies + 1 WHERE month = ${month}::date AND replies < ${settings.replyLimit} RETURNING replies`;
    if (!rows.length) return null;
    const replies = Number(rows[0]!.replies);
    const level = alertLevelFor(replies, settings.replyLimit);
    if (level === 0) return { replies, alert: 0 };
    // Each level alerts once per month, whichever turn crosses it first.
    const raised = await tx.$queryRaw<Array<{ month: Date }>>`
      UPDATE ai_usage_months SET reply_alert_level = ${level} WHERE month = ${month}::date AND reply_alert_level < ${level} RETURNING month`;
    return { replies, alert: raised.length ? level : 0 };
  }

  /** In-app alerts to every admin at 80% and 100% of the monthly limit (FR-038). */
  async alertAdmins(level: 80 | 100, replies: number, settings: UsageSettings): Promise<void> {
    await this.notifications.notifyAdmins({
      type: 'AI_USAGE',
      title: level === 100 ? 'AI reply limit reached' : 'AI replies at 80% of the limit',
      body:
        level === 100
          ? `All ${settings.replyLimit} AI replies of this month are used. Agents hand new messages to your team until the limit is raised or the month ends.`
          : `${replies} of ${settings.replyLimit} AI replies of this month are used.`,
      link: '/ai-usage',
    });
  }

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

  /**
   * Adds a use to the day's row: tokens and cost always, the count only when it is counted (a reply
   * that was not sent costs but does not count). AI replies claim the month with claimReply; the
   * month total here is for assistant requests.
   */
  async record(
    tx: Tx,
    input: {
      kind: UsageKind;
      agentId: string | null;
      numberId: string | null;
      test: boolean;
      usage: TokenUsage;
      costMicros: number;
      at: Date;
      timezone: string;
      countsAgainstMonth: boolean;
      /** False adds tokens and cost without a count. */
      counted?: boolean;
    },
  ): Promise<void> {
    const day = dayKey(input.at, input.timezone);
    const count = input.counted === false ? 0 : 1;
    await tx.$executeRaw`
      INSERT INTO ai_usage_daily (id, day, kind, agent_id, number_id, test, count, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micros)
      VALUES (gen_random_uuid(), ${day}::date, ${input.kind}::"AiUsageKind", ${input.agentId}::uuid, ${input.numberId}::uuid, ${input.test}, ${count},
              ${input.usage.inputTokens}, ${input.usage.cacheReadTokens}, ${input.usage.cacheWriteTokens}, ${input.usage.outputTokens}, ${input.costMicros})
      ON CONFLICT (day, kind, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(number_id, '00000000-0000-0000-0000-000000000000'::uuid), test)
      DO UPDATE SET count = ai_usage_daily.count + EXCLUDED.count,
                    input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
                    cache_read_tokens = ai_usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
                    cache_write_tokens = ai_usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
                    output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
                    cost_micros = ai_usage_daily.cost_micros + EXCLUDED.cost_micros`;
    if (!input.countsAgainstMonth || input.kind !== 'ASSISTANT') return;
    const month = monthKey(input.at, input.timezone);
    await tx.$executeRaw`
      INSERT INTO ai_usage_months (month, assistant_requests) VALUES (${month}::date, 1)
      ON CONFLICT (month) DO UPDATE SET assistant_requests = ai_usage_months.assistant_requests + 1`;
  }
}
