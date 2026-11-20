import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { can } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';

export const TeamMetricsQuerySchema = z.object({ period: z.enum(['today', '7d', '30d']).default('today') });
export type TeamPeriod = z.infer<typeof TeamMetricsQuerySchema>['period'];

/** Calendar days in each period, today included. */
const PERIOD_DAYS: Record<TeamPeriod, number> = { today: 1, '7d': 7, '30d': 30 };

export interface TeamMemberMetrics {
  user: { id: string; name: string };
  intervened: number;
  resolved: number;
  medianFirstResponseSeconds: number | null;
  medianResolutionSeconds: number | null;
}

export interface TeamMetricsDto {
  period: TeamPeriod;
  live: { ACTIVE: number; REQUESTING: number; INTERVENED: number };
  oldestRequestingSince: string | null;
  members: TeamMemberMetrics[];
}

/**
 * The team view (T094, FR-039, research R14). A period starts at local midnight in the company
 * time zone, `days - 1` days ago. Each figure counts the openings whose event fell in the period:
 * - intervened: openings taken by the member
 * - resolved: openings closed by the member (auto-resolve counts for nobody)
 * - first response: customer's first message of the opening → the first reply by a person
 * - resolution: intervention → resolution
 * Live counts use the same rule as the live lists: open window, contact not blocked.
 */
@Injectable()
export class TeamMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(period: TeamPeriod): Promise<TeamMetricsDto> {
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    const timezone = settings?.defaultTimezone ?? 'UTC';
    const [bounds] = await this.prisma.$queryRaw<Array<{ start: Date }>>`
      SELECT ((date_trunc('day', now() AT TIME ZONE ${timezone}) - make_interval(days => ${PERIOD_DAYS[period] - 1}::int)) AT TIME ZONE ${timezone}) AS start`;
    const start = bounds?.start ?? new Date();

    const live = await this.prisma.$queryRaw<Array<{ state: 'ACTIVE' | 'REQUESTING' | 'INTERVENED'; n: number }>>`
      SELECT c.state::text AS state, count(*)::int AS n
        FROM conversations c
        LEFT JOIN contacts k ON k.id = c.contact_id
       WHERE COALESCE(c.last_customer_message_at > now() - interval '24 hours', false) AND k.blocked_at IS NULL
       GROUP BY c.state`;
    const [oldest] = await this.prisma.$queryRaw<Array<{ since: Date | null }>>`
      SELECT min(COALESCE(r.at, c.last_customer_message_at)) AS since
        FROM conversations c
        LEFT JOIN contacts k ON k.id = c.contact_id
        LEFT JOIN LATERAL (
          SELECT max(e.occurred_at) AS at FROM conversation_events e WHERE e.conversation_id = c.id AND e.type = 'REQUESTED'
        ) r ON true
       WHERE c.state = 'REQUESTING'
         AND COALESCE(c.last_customer_message_at > now() - interval '24 hours', false) AND k.blocked_at IS NULL`;

    const stats = await this.prisma.$queryRaw<
      Array<{ user_id: string; intervened: number; resolved: number; median_first_response: number | null; median_resolution: number | null }>
    >`
      WITH taken AS (
        SELECT intervened_by_id AS user_id, count(*)::int AS n
          FROM conversation_openings WHERE intervened_by_id IS NOT NULL AND intervened_at >= ${start}
         GROUP BY 1
      ), closed AS (
        SELECT resolved_by_id AS user_id, count(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - intervened_at)::float8)
                 FILTER (WHERE intervened_at IS NOT NULL) AS median
          FROM conversation_openings WHERE resolved_by_id IS NOT NULL AND resolved_at >= ${start}
         GROUP BY 1
      ), answered AS (
        SELECT first_responder_id AS user_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_human_reply_at - opened_at)::float8) AS median
          FROM conversation_openings WHERE first_responder_id IS NOT NULL AND first_human_reply_at >= ${start}
         GROUP BY 1
      ), people AS (
        SELECT user_id FROM taken UNION SELECT user_id FROM closed UNION SELECT user_id FROM answered
      )
      SELECT p.user_id::text AS user_id, COALESCE(t.n, 0) AS intervened, COALESCE(c.n, 0) AS resolved,
             a.median AS median_first_response, c.median AS median_resolution
        FROM people p
        LEFT JOIN taken t ON t.user_id = p.user_id
        LEFT JOIN closed c ON c.user_id = p.user_id
        LEFT JOIN answered a ON a.user_id = p.user_id`;

    // Every active member who can reply is listed, with zeros when idle; members who have left
    // still appear while they have figures in the period.
    const byId = new Map(stats.map((s) => [s.user_id, s]));
    const users = await this.prisma.user.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { id: { in: [...byId.keys()] } }] },
      select: { id: true, name: true, role: true, status: true },
      orderBy: { name: 'asc' },
    });
    const members = users
      .filter((u) => byId.has(u.id) || (u.status === 'ACTIVE' && can(u.role, 'inbox.reply')))
      .map((u) => {
        const s = byId.get(u.id);
        return {
          user: { id: u.id, name: u.name },
          intervened: s?.intervened ?? 0,
          resolved: s?.resolved ?? 0,
          medianFirstResponseSeconds: s?.median_first_response ?? null,
          medianResolutionSeconds: s?.median_resolution ?? null,
        };
      });

    const count = (state: 'ACTIVE' | 'REQUESTING' | 'INTERVENED') => live.find((row) => row.state === state)?.n ?? 0;
    return {
      period,
      live: { ACTIVE: count('ACTIVE'), REQUESTING: count('REQUESTING'), INTERVENED: count('INTERVENED') },
      oldestRequestingSince: oldest?.since?.toISOString() ?? null,
      members,
    };
  }
}

@Controller('inbox/team-metrics')
export class TeamMetricsController {
  constructor(private readonly metrics: TeamMetricsService) {}

  @Get()
  @Require('inbox.metrics')
  get(@Query(new ZodValidationPipe(TeamMetricsQuerySchema)) query: { period: TeamPeriod }) {
    return this.metrics.get(query.period);
  }
}
