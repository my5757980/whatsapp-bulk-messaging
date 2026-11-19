import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { tierLimit } from '../../campaigns/estimate.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { NumbersService } from '../../numbers/numbers.service.js';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../webhook-router.js';

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const digitsOf = (v: string) => v.replace(/\D/g, '');

/** Size of a messaging-limit tier for comparisons (TIER_UNLIMITED is the largest). */
function tierSize(tier: string | undefined | null): number {
  if (!tier || tier === 'TIER_NOT_SET') return Number.NaN;
  if (tier === 'TIER_UNLIMITED') return Number.POSITIVE_INFINITY;
  return tierLimit(tier) ?? Number.NaN;
}

/**
 * `phone_number_quality_update` (T150, contracts/meta-webhooks.md §6). Meta's reference (Graph
 * v27) sends the display number, an event and the limit tier (`max_daily_conversations_per_business`,
 * or the deprecated `current_limit` / `old_limit`); the quality colour is not included, so it is
 * re-read from the Graph API. A lower tier (or a legacy FLAGGED / DOWNGRADE event) notifies
 * admins with QUALITY_DROPPED.
 */
@Injectable()
export class QualityHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'phone_number_quality_update';
  private readonly logger = new Logger(QualityHandler.name);

  constructor(
    private readonly router: WebhookRouter,
    private readonly prisma: PrismaService,
    private readonly numbers: NumbersService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    const value = change.value;
    const display = digitsOf(str(value.display_phone_number) ?? '');
    if (!display) return;
    const candidates = await this.prisma.whatsAppNumber.findMany({
      where: change.wabaId ? { wabaId: change.wabaId } : {},
      select: { id: true, label: true, displayPhoneNumber: true, messagingLimitTier: true },
    });
    const number = candidates.find((n) => digitsOf(n.displayPhoneNumber) === display);
    if (!number) return;

    const event = (str(value.event) ?? '').toUpperCase();
    const newTier = str(value.max_daily_conversations_per_business) ?? str(value.current_limit);
    const oldTier = str(value.old_limit) ?? number.messagingLimitTier ?? undefined;
    if (newTier && newTier !== 'TIER_NOT_SET' && newTier !== number.messagingLimitTier) {
      await this.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { messagingLimitTier: newTier } });
    }
    const dropped = event === 'DOWNGRADE' || event === 'FLAGGED' || tierSize(newTier) < tierSize(oldTier);

    // The webhook has no quality rating; read the current one (and throughput) from Meta.
    await this.numbers.refresh(number.id).catch((error: unknown) => this.logger.warn({ numberId: number.id, err: (error as Error).message }, 'Refresh after quality update failed'));

    if (dropped) {
      await this.notifications.notifyAdmins({
        type: 'QUALITY_DROPPED',
        title: 'WhatsApp number quality or limit dropped',
        body: `${number.label}: ${newTier ? `messaging limit is now ${newTier.replace('TIER_', '')}` : 'Meta flagged the number quality'}. Review recent campaigns and reduce volume.`,
        link: '/settings/numbers',
      });
    }
  }
}
