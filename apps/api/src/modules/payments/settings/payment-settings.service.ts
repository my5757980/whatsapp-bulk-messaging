import { Injectable } from '@nestjs/common';
import { PAYMENT_LIMITS, reminderRulesProblem } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentSettings, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { VariableMappingSchema } from '../../campaigns/variable-resolver.js';
import { PaymentSender } from '../requests/payment-sender.js';

// Payment settings (feature 008, FR-006 – FR-008, FR-017, FR-027, contracts/commerce-api.openapi.yaml
// PaymentSettingsInput): one row, created with defaults on first read. Templates must carry the pay
// link button; reminders follow the shared rules (US4), the chat order tag must exist (US6).

export interface ReminderSetting {
  beforeMinutes: number;
  templateId: string;
  mapping?: Record<string, unknown>;
}

const ReminderSchema = z.object({ beforeMinutes: z.number().int(), templateId: z.uuid(), mapping: VariableMappingSchema.optional() }).strict();

export const PaymentSettingsSchema = z
  .object({
    maxAmountMinor: z.number().int().min(200).max(100_000_000_00),
    defaultExpiryMinutes: z.number().int().min(PAYMENT_LIMITS.expiryMinutesMin).max(PAYMENT_LIMITS.expiryMinutesMax),
    requestRoles: z.array(z.enum(['ADMIN', 'MANAGER', 'AGENT'])).min(1),
    sessionText: z.string().trim().min(1).max(PAYMENT_LIMITS.sessionTextMax),
    buttonText: z.string().trim().min(1).max(PAYMENT_LIMITS.buttonTextMax),
    templateId: z.uuid().nullable(),
    templateMapping: VariableMappingSchema.default({}),
    reminders: z.array(ReminderSchema).max(PAYMENT_LIMITS.remindersMax).default([]),
    chatOrderMode: z.enum(['AUTO', 'REVIEW']),
    chatOrderExpiryMinutes: z.number().int().min(PAYMENT_LIMITS.expiryMinutesMin).max(PAYMENT_LIMITS.expiryMinutesMax),
    chatOrderTagId: z.uuid().nullable(),
  })
  .strict();
export type PaymentSettingsInput = z.infer<typeof PaymentSettingsSchema>;

@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sender: PaymentSender,
  ) {}

  /** The settings row, made with the defaults when missing. */
  async row(): Promise<PaymentSettings> {
    const found = await this.prisma.paymentSettings.findFirst();
    if (found) return found;
    try {
      return await this.prisma.paymentSettings.create({ data: {} });
    } catch {
      // Another request made it first (the table holds one row).
      return this.prisma.paymentSettings.findFirstOrThrow();
    }
  }

  async get() {
    const row = await this.row();
    const template = row.templateId ? await this.prisma.template.findUnique({ where: { id: row.templateId }, select: { name: true } }) : null;
    return this.dto({ ...row, template });
  }

  async update(input: PaymentSettingsInput, actor: AuditActor) {
    if (input.templateId) await this.mustBePayLinkTemplate(input.templateId, 'templateId');
    const reminderProblem = reminderRulesProblem(input.reminders);
    if (reminderProblem) throw AppError.validation(reminderProblem, [{ field: 'reminders', issue: reminderProblem }]);
    for (const [i, reminder] of input.reminders.entries()) await this.mustBePayLinkTemplate(reminder.templateId, `reminders.${i}.templateId`);
    if (input.chatOrderTagId && !(await this.prisma.tag.findUnique({ where: { id: input.chatOrderTagId }, select: { id: true } }))) {
      throw AppError.validation('The chat order tag does not exist', [{ field: 'chatOrderTagId', issue: 'not found' }]);
    }
    const current = await this.row();
    const updated = await this.prisma.paymentSettings.update({
      where: { id: current.id },
      data: {
        maxAmountMinor: BigInt(input.maxAmountMinor),
        defaultExpiryMinutes: input.defaultExpiryMinutes,
        requestRoles: input.requestRoles,
        sessionText: input.sessionText,
        buttonText: input.buttonText,
        templateId: input.templateId,
        templateMapping: input.templateMapping as Prisma.InputJsonValue,
        reminders: input.reminders as unknown as Prisma.InputJsonValue,
        chatOrderMode: input.chatOrderMode,
        chatOrderExpiryMinutes: input.chatOrderExpiryMinutes,
        chatOrderTagId: input.chatOrderTagId,
        updatedById: actor.userId ?? null,
      },
    });
    await this.audit.record(actor, 'payments.settings_changed', { type: 'payment_settings', id: updated.id }, {
      maxAmountMinor: input.maxAmountMinor,
      requestRoles: input.requestRoles,
      templateId: input.templateId,
      reminders: input.reminders.length,
      chatOrderMode: input.chatOrderMode,
    });
    return this.get();
  }

  private async mustBePayLinkTemplate(templateId: string, field: string): Promise<void> {
    const template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw AppError.validation('The template does not exist', [{ field, issue: 'not found' }]);
    if (this.sender.payLinkButton(template) < 0) {
      throw AppError.validation('Choose a template with a pay link button (a website button ending in /p/{{1}} on the link address)', [{ field, issue: 'has no pay link button' }], 'TEMPLATE_NOT_PAY_LINK');
    }
  }

  dto(row: PaymentSettings & { template?: { name: string } | null }) {
    return {
      maxAmountMinor: Number(row.maxAmountMinor),
      defaultExpiryMinutes: row.defaultExpiryMinutes,
      requestRoles: row.requestRoles as Array<'ADMIN' | 'MANAGER' | 'AGENT'>,
      sessionText: row.sessionText,
      buttonText: row.buttonText,
      templateId: row.templateId,
      templateName: row.template?.name ?? null,
      templateMapping: (row.templateMapping ?? {}) as Record<string, unknown>,
      reminders: (row.reminders ?? []) as unknown as ReminderSetting[],
      chatOrderMode: row.chatOrderMode === 'AUTO' ? ('AUTO' as const) : ('REVIEW' as const),
      chatOrderExpiryMinutes: row.chatOrderExpiryMinutes,
      chatOrderTagId: row.chatOrderTagId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
