import { Injectable } from '@nestjs/common';
import { alertLevelFor, monthKey } from '@wbm/shared';
import { z } from 'zod';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { AiUsageService } from './usage.service.js';

export const UsageQuerySchema = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM').optional() });
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const AiSettingsSchema = z.strictObject({
  replyLimit: z.int().min(0).max(1_000_000),
  assistantLimit: z.int().min(0).max(100_000),
  prices: z.strictObject({
    model: z.string().trim().min(1).max(60),
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
  }),
  limitMessage: z.string().trim().max(500).nullable(),
});
export type AiSettingsInput = z.infer<typeof AiSettingsSchema>;

const usd = (micros: number | bigint) => Number(micros) / 1_000_000;

/** How AI conversations ended, grouped for the usage page (FR-037, data-model.md §3). */
const OUTCOME_GROUP: Record<string, 'answered' | 'handedOver' | 'memberTook' | 'limitReached' | 'failed' | 'other'> = {
  EXPIRED: 'answered',
  CLOSED: 'answered',
  HANDED_OVER: 'handedOver',
  MEMBER_TOOK: 'memberTook',
  LIMIT_REACHED: 'limitReached',
  FAILED: 'failed',
};

/**
 * The AI usage page and its settings (004 T089, FR-037–FR-039): replies against the monthly limit,
 * test replies apart, preview turns, assistant requests, cost per agent and per day from the measured
 * tokens, and how AI conversations ended; limits, prices and the limit message for admins.
 */
@Injectable()
export class AiUsageReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageService,
    private readonly audit: AuditService,
  ) {}

  async report(query: UsageQuery) {
    const settings = await this.usage.settings();
    const first = query.month ? `${query.month}-01` : monthKey(new Date(), settings.timezone);
    const [year, month] = first.split('-').map(Number) as [number, number];
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const tz = settings.timezone;

    const [monthRow] = await this.prisma.$queryRaw<Array<{ replies: number; assistant_requests: number }>>`
      SELECT replies, assistant_requests FROM ai_usage_months WHERE month = ${first}::date`;
    const daily = await this.prisma.$queryRaw<Array<{ day: Date; kind: string; agent_id: string | null; test: boolean; count: number; cost_micros: bigint }>>`
      SELECT day, kind::text AS kind, agent_id, test, count, cost_micros FROM ai_usage_daily WHERE day >= ${first}::date AND day < ${next}::date`;
    const outcomes = await this.prisma.$queryRaw<Array<{ result: string | null; n: bigint }>>`
      SELECT result::text AS result, count(*) AS n FROM ai_conversations
       WHERE status = 'ENDED' AND (ended_at AT TIME ZONE ${tz}) >= ${first}::timestamp AND (ended_at AT TIME ZONE ${tz}) < ${next}::timestamp
       GROUP BY result`;

    const agentIds = [...new Set(daily.map((d) => d.agent_id).filter((id): id is string => id !== null))];
    const names = new Map((await this.prisma.aiAgent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
    const byAgent = new Map<string, { agentId: string; name: string; replies: number; testReplies: number; cost: bigint }>();
    const byDay = new Map<string, { day: string; replies: number; cost: bigint }>();
    let testReplies = 0;
    let previewTurns = 0;
    let cost = 0n;
    for (const row of daily) {
      const count = Number(row.count);
      cost += BigInt(row.cost_micros);
      const day = row.day.toISOString().slice(0, 10);
      const dayRow = byDay.get(day) ?? { day, replies: 0, cost: 0n };
      dayRow.cost += BigInt(row.cost_micros);
      if (row.kind === 'REPLY') dayRow.replies += count;
      byDay.set(day, dayRow);
      if (row.kind === 'REPLY' && row.test) testReplies += count;
      if (row.kind === 'PREVIEW') previewTurns += count;
      if (row.agent_id) {
        const agent = byAgent.get(row.agent_id) ?? { agentId: row.agent_id, name: names.get(row.agent_id) ?? 'Deleted agent', replies: 0, testReplies: 0, cost: 0n };
        agent.cost += BigInt(row.cost_micros);
        if (row.kind === 'REPLY') {
          if (row.test) agent.testReplies += count;
          else agent.replies += count;
        }
        byAgent.set(row.agent_id, agent);
      }
    }
    const conversations = { answered: 0, handedOver: 0, memberTook: 0, limitReached: 0, failed: 0, other: 0 };
    for (const row of outcomes) conversations[OUTCOME_GROUP[row.result ?? ''] ?? 'other'] += Number(row.n);

    return {
      month: first.slice(0, 7),
      replies: Number(monthRow?.replies ?? 0),
      replyLimit: settings.replyLimit,
      testReplies,
      previewTurns,
      assistantRequests: Number(monthRow?.assistant_requests ?? 0),
      assistantLimit: settings.assistantLimit,
      estimatedCostUsd: usd(cost),
      byAgent: [...byAgent.values()]
        .sort((a, b) => b.replies + b.testReplies - (a.replies + a.testReplies) || a.name.localeCompare(b.name))
        .map(({ cost: agentCost, ...rest }) => ({ ...rest, costUsd: usd(agentCost) })),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ cost: dayCost, ...rest }) => ({ ...rest, costUsd: usd(dayCost) })),
      conversations,
    };
  }

  async settings() {
    const s = await this.usage.settings();
    return { replyLimit: s.replyLimit, assistantLimit: s.assistantLimit, prices: s.prices, limitMessage: s.limitMessage };
  }

  /**
   * Saves limits, prices and the limit message (audited). A new limit applies at once (FR-039); the
   * month's alert level is set to what the current count is under the new limit, so the alerts for
   * the new limit still come.
   */
  async updateSettings(input: AiSettingsInput, actor: AuditActor) {
    const before = await this.usage.settings();
    const limitMessage = input.limitMessage?.trim() ? input.limitMessage.trim() : null;
    await this.prisma.settings.update({
      where: { id: 1 },
      data: { aiReplyLimit: input.replyLimit, aiAssistantLimit: input.assistantLimit, aiPrices: input.prices as Prisma.InputJsonValue, aiLimitMessage: limitMessage },
    });
    if (input.replyLimit !== before.replyLimit) {
      const month = monthKey(new Date(), before.timezone);
      const [row] = await this.prisma.$queryRaw<Array<{ replies: number }>>`SELECT replies FROM ai_usage_months WHERE month = ${month}::date`;
      const level = alertLevelFor(Number(row?.replies ?? 0), input.replyLimit);
      await this.prisma.$executeRaw`UPDATE ai_usage_months SET reply_alert_level = ${level} WHERE month = ${month}::date`;
    }
    await this.audit.record(
      actor,
      'ai.limits_changed',
      { type: 'settings', id: '1' },
      {
        replyLimit: { from: before.replyLimit, to: input.replyLimit },
        assistantLimit: { from: before.assistantLimit, to: input.assistantLimit },
        pricesChanged: JSON.stringify(before.prices) !== JSON.stringify(input.prices),
        limitMessageChanged: before.limitMessage !== limitMessage,
      },
    );
    return this.settings();
  }
}
