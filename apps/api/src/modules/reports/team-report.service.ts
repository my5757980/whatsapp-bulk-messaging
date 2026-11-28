import { Injectable } from '@nestjs/common';
import { can } from '@wbm/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { CLICKED, DELIVERED, REPLIED } from '../campaigns/replied.sql.js';
import { COUNTS, toCounts, type Counts, type CountsRow, type ReportRange } from './report-range.js';

// Feature 009 (research R14, FR-035): each member's campaigns launched in the range (by
// campaigns.launched_by_id) with their totals, and the 002 live chat figures in the range with the
// team view's definitions (taken, closed, first response). Removed members with figures stay listed.

export interface TeamMemberReport {
  userId: string;
  name: string;
  active: boolean;
  campaignsLaunched: number;
  campaignTotals: Counts;
  chatsTaken: number;
  chatsClosed: number;
  repliesSent: number;
  medianFirstResponseSeconds: number | null;
}

@Injectable()
export class TeamReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(range: ReportRange): Promise<{ from: string; to: string; members: TeamMemberReport[] }> {
    const { start, end } = range;
    const launched = await this.prisma.$queryRaw<Array<{ user_id: string; n: number }>>`
      SELECT c.launched_by_id::text AS user_id, COUNT(*)::int AS n
        FROM campaigns c
       WHERE c.launched_by_id IS NOT NULL AND c.launched_at >= ${start} AND c.launched_at < ${end}
       GROUP BY 1`;
    const totals = await this.prisma.$queryRaw<Array<CountsRow & { user_id: string }>>`
      WITH base AS (
        SELECT m.status, m.contact_id, m.cost_usd_micros, c.launched_by_id,
               (${DELIVERED} AND ${REPLIED}) AS replied, ${CLICKED} AS clicked
          FROM campaigns c JOIN messages m ON m.campaign_id = c.id
         WHERE c.launched_by_id IS NOT NULL AND c.launched_at >= ${start} AND c.launched_at < ${end}
      )
      SELECT m.launched_by_id::text AS user_id, ${COUNTS} FROM base m GROUP BY 1`;
    const chats = await this.prisma.$queryRaw<Array<{ user_id: string; taken: number; closed: number; replies: number; median: number | null }>>`
      WITH taken AS (
        SELECT intervened_by_id AS user_id, count(*)::int AS n
          FROM conversation_openings WHERE intervened_by_id IS NOT NULL AND intervened_at >= ${start} AND intervened_at < ${end}
         GROUP BY 1
      ), closed AS (
        SELECT resolved_by_id AS user_id, count(*)::int AS n
          FROM conversation_openings WHERE resolved_by_id IS NOT NULL AND resolved_at >= ${start} AND resolved_at < ${end}
         GROUP BY 1
      ), answered AS (
        SELECT first_responder_id AS user_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_human_reply_at - opened_at)::float8) AS median
          FROM conversation_openings WHERE first_responder_id IS NOT NULL AND first_human_reply_at >= ${start} AND first_human_reply_at < ${end}
         GROUP BY 1
      ), replies AS (
        SELECT sent_by_user_id AS user_id, count(*)::int AS n
          FROM chat_messages WHERE sent_by_user_id IS NOT NULL AND kind = 'SESSION_OUT' AND occurred_at >= ${start} AND occurred_at < ${end}
         GROUP BY 1
      ), people AS (
        SELECT user_id FROM taken UNION SELECT user_id FROM closed UNION SELECT user_id FROM answered UNION SELECT user_id FROM replies
      )
      SELECT p.user_id::text AS user_id, COALESCE(t.n, 0) AS taken, COALESCE(c.n, 0) AS closed, COALESCE(r.n, 0) AS replies, a.median
        FROM people p
        LEFT JOIN taken t ON t.user_id = p.user_id
        LEFT JOIN closed c ON c.user_id = p.user_id
        LEFT JOIN answered a ON a.user_id = p.user_id
        LEFT JOIN replies r ON r.user_id = p.user_id`;

    const launchedBy = new Map(launched.map((r) => [r.user_id, r.n]));
    const totalsBy = new Map(totals.map((r) => [r.user_id, r]));
    const chatsBy = new Map(chats.map((r) => [r.user_id, r]));
    const withFigures = new Set([...launchedBy.keys(), ...totalsBy.keys(), ...chatsBy.keys()]);
    const users = await this.prisma.user.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { id: { in: [...withFigures] } }] },
      select: { id: true, name: true, role: true, status: true },
      orderBy: { name: 'asc' },
    });
    const members = users
      .filter((u) => withFigures.has(u.id) || (u.status === 'ACTIVE' && (can(u.role, 'campaigns.launch') || can(u.role, 'inbox.reply'))))
      .map((u) => {
        const chat = chatsBy.get(u.id);
        return {
          userId: u.id,
          name: u.name,
          active: u.status !== 'DEACTIVATED',
          campaignsLaunched: launchedBy.get(u.id) ?? 0,
          campaignTotals: toCounts(totalsBy.get(u.id)),
          chatsTaken: chat?.taken ?? 0,
          chatsClosed: chat?.closed ?? 0,
          repliesSent: chat?.replies ?? 0,
          medianFirstResponseSeconds: chat?.median ?? null,
        };
      });
    return { from: range.from, to: range.to, members };
  }
}
