import { HttpStatus, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma, Template } from '../../../generated/prisma/client.js';
import type { CampaignPaymentConfig, CampaignPaymentContext, CampaignPaymentRecipient, CampaignPaymentsPort } from '../../campaigns/campaign-payments.port.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PaymentSender } from '../requests/payment-sender.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';
import { firstReminderAt } from '../tick/payment-reminders.js';

// Campaign payment requests (feature 008 US3, FR-009, research R5): one request per recipient, made in
// the launch transaction with the recipient's message, with no Stripe call; the Checkout Session is
// made when the customer first opens the link (payment-sessions.ts). Campaign requests are not
// announced one by one with `payment.requested` (a launch can make tens of thousands); their
// payments, expiries and refunds are.

@Injectable()
export class CampaignPayments implements CampaignPaymentsPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly sender: PaymentSender,
  ) {}

  async context(template: Pick<Template, 'components'>): Promise<CampaignPaymentContext> {
    const access = await this.gateway.requireReady();
    const buttonIndex = this.sender.payLinkButton(template);
    if (buttonIndex < 0) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'TEMPLATE_NOT_PAY_LINK', `A campaign that asks for payment needs a template with a URL button to ${this.sender.linkBase()}/p/{{1}}`, [
        { field: 'templateId', issue: 'has no pay link button' },
      ]);
    }
    const settings = await this.settings.row();
    const zone = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    return { currency: access.currency, maxAmountMinor: Number(settings.maxAmountMinor), buttonIndex, linkBase: this.sender.linkBase(), timeZone: zone?.defaultTimezone ?? 'UTC', livemode: access.livemode };
  }

  async createMany(tx: Prisma.TransactionClient, campaign: { id: string; config: CampaignPaymentConfig; context: CampaignPaymentContext }, recipients: CampaignPaymentRecipient[]): Promise<void> {
    if (!recipients.length) return;
    const settings = await this.settings.row();
    const now = new Date();
    await tx.paymentRequest.createMany({
      data: recipients.map((r) => ({
        id: uuidv7(),
        code: r.payment.code,
        contactId: r.contactId,
        phoneE164: r.phoneE164,
        customerName: r.customerName,
        amountMinor: BigInt(r.payment.amountMinor),
        currency: campaign.context.currency,
        description: r.payment.description,
        expiresAt: r.payment.expiresAt,
        status: 'WAITING' as const,
        source: 'CAMPAIGN' as const,
        campaignId: campaign.id,
        messageId: r.messageId,
        tagId: campaign.config.tagId ?? null,
        flowId: campaign.config.flowId ?? null,
        isTest: !campaign.context.livemode,
        nextReminderAt: firstReminderAt(settings, now, r.payment.expiresAt),
      })),
    });
  }
}
