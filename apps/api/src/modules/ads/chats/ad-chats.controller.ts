import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';

// Chats from ads (feature 007 US3, FR-021, FR-022, contracts/ads-api.openapi.yaml): the contacts who
// started chats from a campaign (phones masked by the global interceptor without phones.full), and
// chats from ads made outside the platform, grouped by Meta's ad id.

const PageSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

@Controller('ads')
export class AdChatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('campaigns/:id/chats')
  @Require('campaigns.view')
  async chats(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(PageSchema)) query: z.infer<typeof PageSchema>) {
    const campaign = await this.prisma.adCampaign.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!campaign) throw AppError.notFound('Ad campaign not found');
    const [total, rows] = await Promise.all([
      this.prisma.adChatStart.count({ where: { adCampaignId: id } }),
      this.prisma.adChatStart.findMany({
        where: { adCampaignId: id },
        orderBy: { startedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: { id: true, conversationId: true, newContact: true, startedAt: true, contact: { select: { id: true, name: true, phoneE164: true } } },
      }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        contact: r.contact ? { id: r.contact.id, name: r.contact.name, phone: r.contact.phoneE164 } : null,
        conversationId: r.conversationId,
        newContact: r.newContact,
        startedAt: r.startedAt.toISOString(),
      })),
    };
  }

  @Get('other-chats')
  @Require('campaigns.view')
  async otherChats() {
    const rows = await this.prisma.$queryRaw<Array<{ meta_ad_id: string; headline: string | null; chats: bigint; new_contacts: bigint; last_at: Date }>>`
      SELECT meta_ad_id,
             (array_agg(headline ORDER BY started_at DESC) FILTER (WHERE headline IS NOT NULL))[1] AS headline,
             count(*) AS chats,
             count(*) FILTER (WHERE new_contact) AS new_contacts,
             max(started_at) AS last_at
        FROM ad_chat_starts
       WHERE ad_campaign_id IS NULL
       GROUP BY meta_ad_id
       ORDER BY max(started_at) DESC
       LIMIT 200`;
    return rows.map((r) => ({ metaAdId: r.meta_ad_id, headline: r.headline, chats: Number(r.chats), newContacts: Number(r.new_contacts), lastAt: r.last_at.toISOString() }));
  }
}
