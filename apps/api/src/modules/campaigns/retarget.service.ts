import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { CampaignsService } from './campaigns.service.js';

// Retargeting (FR-031, T163): a new DRAFT whose RETARGET audience is the source campaign's
// recipients in a group. Recipients are snapshotted when it launches, and contacts who have opted
// out since are excluded by the usual consent rules. Feature 005 (US2, research R6) adds the
// groups Clicked, Not clicked, Replied, Not replied and Held back, and their sizes beforehand.

export const RETARGET_GROUPS = ['FAILED', 'NOT_READ', 'READ', 'DELIVERED', 'CLICKED', 'NOT_CLICKED', 'REPLIED', 'NOT_REPLIED', 'HELD_BACK', 'PAID', 'NOT_PAID'] as const;
export type RetargetGroup = (typeof RETARGET_GROUPS)[number];

export const RetargetSchema = z.object({ status: z.enum(RETARGET_GROUPS) }).strict();
export type RetargetInput = z.infer<typeof RetargetSchema>;

const LABEL: Record<RetargetGroup, string> = {
  FAILED: 'failed',
  NOT_READ: 'not read',
  READ: 'read',
  DELIVERED: 'delivered',
  CLICKED: 'clicked',
  NOT_CLICKED: 'not clicked',
  REPLIED: 'replied',
  NOT_REPLIED: 'not replied',
  HELD_BACK: 'held back',
  PAID: 'paid',
  NOT_PAID: 'not paid',
};

/** Hours after delivery in which a message from the contact counts as a reply (FR-012). */
export const REPLY_WINDOW_HOURS = 72;

const DELIVERED = Prisma.sql`m.status IN ('DELIVERED', 'READ')`;
const CLICKED = Prisma.sql`EXISTS (SELECT 1 FROM tracked_links tl JOIN link_clicks lc ON lc.tracked_link_id = tl.id WHERE tl.message_id = m.id)`;
const REPLIED = Prisma.sql`EXISTS (
  SELECT 1 FROM conversations cv JOIN chat_messages cm ON cm.conversation_id = cv.id
   WHERE cv.contact_id = m.contact_id AND cv.number_id = m.number_id AND cm.kind = 'INBOUND'
     AND cm.occurred_at >= COALESCE(m.delivered_at, m.read_at)
     AND cm.occurred_at < COALESCE(m.delivered_at, m.read_at) + ${Prisma.raw(`interval '${REPLY_WINDOW_HOURS} hours'`)})`;

// Feature 008 (US4): the recipient's payment request from a campaign with a payment config.
const PAID = Prisma.sql`EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.message_id = m.id AND pr.status IN ('PAID', 'REFUNDED'))`;
const NOT_PAID = Prisma.sql`EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.message_id = m.id AND pr.status IN ('WAITING', 'EXPIRED', 'CANCELLED'))`;

/** Which messages (alias `m`) of the source campaign belong to a group. */
export function retargetCondition(group: RetargetGroup): Prisma.Sql {
  switch (group) {
    case 'FAILED':
      return Prisma.sql`m.status = 'FAILED'`;
    case 'NOT_READ':
      return Prisma.sql`m.status IN ('SENT', 'DELIVERED')`;
    case 'READ':
      return Prisma.sql`m.status = 'READ'`;
    case 'DELIVERED':
      return DELIVERED;
    case 'CLICKED':
      return CLICKED;
    case 'NOT_CLICKED':
      return Prisma.sql`${DELIVERED} AND NOT ${CLICKED}`;
    case 'REPLIED':
      return Prisma.sql`${DELIVERED} AND ${REPLIED}`;
    case 'NOT_REPLIED':
      return Prisma.sql`${DELIVERED} AND NOT ${REPLIED}`;
    case 'HELD_BACK':
      // Meta's per-person marketing limit (131049): never retried within 24 hours (FR-014).
      return Prisma.sql`m.status = 'FAILED' AND m.failure_code = 131049`;
    case 'PAID':
      return PAID;
    case 'NOT_PAID':
      // Only those who got the request: a failed send is the FAILED group.
      return Prisma.sql`${DELIVERED} AND ${NOT_PAID}`;
  }
}

export interface RetargetGroupSize {
  status: RetargetGroup;
  count: number;
  available: boolean;
}

@Injectable()
export class RetargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  /** The number of contacts in each group right now (FR-011); deleted contacts are not counted. */
  async groups(campaignId: string): Promise<{ groups: RetargetGroupSize[] }> {
    await this.campaigns.getRow(campaignId);
    const columns = Prisma.join(RETARGET_GROUPS.map((g) => Prisma.sql`COUNT(*) FILTER (WHERE ${retargetCondition(g)})::int AS ${Prisma.raw(`"${g}"`)}`));
    const [row] = await this.prisma.$queryRaw<Array<Record<RetargetGroup, number>>>`
      SELECT ${columns} FROM messages m WHERE m.campaign_id = ${campaignId}::uuid AND m.contact_id IS NOT NULL`;
    return { groups: RETARGET_GROUPS.map((status) => ({ status, count: row?.[status] ?? 0, available: (row?.[status] ?? 0) > 0 })) };
  }

  async retarget(sourceId: string, input: RetargetInput, userId: string) {
    const source = await this.campaigns.getRow(sourceId);
    if (source.state === 'DRAFT' || source.state === 'SCHEDULED') throw AppError.conflict('Retarget a campaign once it has started sending');
    if (!(await this.prisma.message.count({ where: { campaignId: sourceId } }))) {
      throw AppError.conflict("This campaign's messages were removed after 12 months, so it cannot be retargeted");
    }
    const targets = await this.prisma.trackedLinkTarget.findMany({ where: { campaignId: sourceId } });
    const created = await this.prisma.campaign.create({
      data: {
        name: `${source.name} - retarget ${LABEL[input.status]}`.slice(0, 120),
        numberId: source.numberId,
        templateId: source.templateId,
        audienceType: 'RETARGET',
        sourceCampaignId: source.id,
        retargetStatus: input.status,
        variableMapping: (source.variableMapping ?? {}) as Prisma.InputJsonValue,
        headerMediaAssetId: source.headerMediaAssetId,
        // Feature 008: a payment campaign asks again (new links), except the payers.
        ...(source.paymentConfig && input.status !== 'PAID' ? { paymentConfig: source.paymentConfig as Prisma.InputJsonValue } : {}),
        timezone: source.timezone,
        createdById: userId,
        // Tracked links keep their destinations, so the draft can be sent as it is (feature 005).
        trackedLinkTargets: { create: targets.map((t) => ({ variableKey: t.variableKey, destination: t.destination, addCampaignTags: t.addCampaignTags })) },
      },
    });
    return this.campaigns.get(created.id);
  }
}
