import { Injectable, Logger } from '@nestjs/common';
import { nextReminder, orderedReminders } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest, PaymentSettings } from '../../../generated/prisma/client.js';
import { PaymentSender } from '../requests/payment-sender.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';

// Payment reminders (feature 008 US4, FR-017, research R6): up to two templates before a waiting
// request expires, from due times in Postgres (`next_reminder_at`), sent by the 60-second payments
// tick through the 001 queue (origin PAYMENTS) with its opt-out checks. A reminder goes out only when
// the request's own message reached the customer, at most once per slot: the slot is claimed by moving
// `next_reminder_at` on before sending. Paying, cancelling and expiry clear it.

export interface ReminderRuleRow {
  beforeMinutes: number;
  templateId: string;
  mapping?: Record<string, unknown>;
}

const SEEN = new Set(['DELIVERED', 'READ']);
const BATCH = 200;

export function reminderRules(settings: Pick<PaymentSettings, 'reminders'>): ReminderRuleRow[] {
  const list = Array.isArray(settings.reminders) ? (settings.reminders as unknown as ReminderRuleRow[]) : [];
  return orderedReminders(list.filter((r) => r && typeof r.beforeMinutes === 'number' && typeof r.templateId === 'string'));
}

/** The first reminder of a new request, or null when none fits before its expiry. */
export function firstReminderAt(settings: Pick<PaymentSettings, 'reminders'>, createdAt: Date, expiresAt: Date): Date | null {
  const next = nextReminder({ createdAt: createdAt.getTime(), expiresAt: expiresAt.getTime(), rules: reminderRules(settings), processed: 0 });
  return next ? new Date(next.at) : null;
}

@Injectable()
export class PaymentReminders {
  private readonly logger = new Logger(PaymentReminders.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PaymentSettingsService,
    private readonly sender: PaymentSender,
  ) {}

  /** Sends the reminders due by `now`; the number sent. */
  async sendDue(now: Date): Promise<number> {
    const due = await this.prisma.paymentRequest.findMany({ where: { status: 'WAITING', nextReminderAt: { lte: now } }, orderBy: { nextReminderAt: 'asc' }, take: BATCH });
    if (!due.length) return 0;
    const rules = reminderRules(await this.settings.row());
    let sent = 0;
    for (const row of due) {
      const at = row.nextReminderAt!.getTime();
      const expires = row.expiresAt.getTime();
      const time = (rule: ReminderRuleRow) => expires - rule.beforeMinutes * 60_000;
      // The slot this time belongs to (or the next one, when the settings changed since).
      let slot = rules.findIndex((r) => time(r) === at);
      if (slot < 0) slot = rules.findIndex((r) => time(r) >= at);
      const following = slot < 0 ? null : nextReminder({ createdAt: row.createdAt.getTime(), expiresAt: expires, rules, processed: slot + 1 });
      const { count } = await this.prisma.paymentRequest.updateMany({
        where: { id: row.id, status: 'WAITING', nextReminderAt: row.nextReminderAt },
        data: { nextReminderAt: following ? new Date(following.at) : null },
      });
      if (!count || slot < 0) continue;
      if (await this.remind(row, rules[slot]!)) {
        sent += 1;
        await this.prisma.paymentRequest.update({ where: { id: row.id }, data: { remindersSent: { increment: 1 } } });
      }
    }
    return sent;
  }

  private async remind(row: PaymentRequest, rule: ReminderRuleRow): Promise<boolean> {
    if (!row.contactId) return false;
    if (!(await this.delivered(row))) return false;
    const numberId = await this.numberOf(row);
    if (!numberId) return false;
    const [template, number] = await Promise.all([
      this.prisma.template.findUnique({ where: { id: rule.templateId } }),
      this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { wabaId: true, connectionStatus: true, sendingEnabled: true } }),
    ]);
    if (!template || template.status !== 'APPROVED' || !number || number.connectionStatus !== 'CONNECTED' || !number.sendingEnabled || template.wabaId !== number.wabaId) return false;
    if (this.sender.payLinkButton(template) < 0) return false;
    try {
      await this.sender.template({ conversationId: row.conversationId, numberId, contactId: row.contactId }, row, template, rule.mapping ?? {}, { automatic: true, keepLinks: true });
      return true;
    } catch (error) {
      // An opted-out contact and a marketing template, or a value missing: this reminder is skipped.
      this.logger.log({ paymentRequestId: row.id, reason: error instanceof Error ? error.message : 'unknown' }, 'Payment reminder skipped');
      return false;
    }
  }

  /** True when the request's own message (Pay now or template) reached the customer. */
  private async delivered(row: PaymentRequest): Promise<boolean> {
    if (row.chatItemId) {
      const item = await this.prisma.chatMessage.findUnique({ where: { id: row.chatItemId }, select: { status: true, messageId: true } });
      if (item?.status && SEEN.has(item.status)) return true;
      if (item?.messageId) {
        const message = await this.prisma.message.findUnique({ where: { id: item.messageId }, select: { status: true } });
        if (message && SEEN.has(message.status)) return true;
      }
    }
    if (row.messageId) {
      const message = await this.prisma.message.findUnique({ where: { id: row.messageId }, select: { status: true } });
      if (message && SEEN.has(message.status)) return true;
    }
    return false;
  }

  /** The number that sent the request: its chat's, else its message's. */
  private async numberOf(row: PaymentRequest): Promise<string | null> {
    if (row.conversationId) {
      const chat = await this.prisma.conversation.findUnique({ where: { id: row.conversationId }, select: { numberId: true } });
      if (chat) return chat.numberId;
    }
    if (row.messageId) {
      const message = await this.prisma.message.findUnique({ where: { id: row.messageId }, select: { numberId: true } });
      if (message) return message.numberId;
    }
    return null;
  }
}
