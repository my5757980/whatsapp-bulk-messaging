import { Inject, Injectable } from '@nestjs/common';
import { payLinkButtonIndex } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { PaymentRequest, PaymentSettings, Prisma, Template } from '../../../generated/prisma/client.js';
import { VariableMappingSchema, resolveVariables } from '../../campaigns/variable-resolver.js';
import { previewOf } from '../../inbox/inbound/message-parser.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { chatTemplateSendJob, requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import { assertConsent } from '../../sending/template-send-rules.js';
import { chatSummary, fillSessionText, paymentWords } from './payment-views.js';
import { GlobalAttributesService } from '../../settings/global-attributes.service.js';

// Sending a payment request (feature 008 US2/US3, FR-007, research R5): inside the 24-hour window an
// interactive cta_url "Pay now" message through the 002 priority send path; outside it the payment
// template through the 001 queue (origin PAYMENTS) with the request's code in its pay link button.

/** The template buttons of a stored template (Meta component format). */
function templateButtons(components: unknown): Array<{ type: string; url?: string }> {
  const list = Array.isArray(components) ? (components as Array<{ type?: string; buttons?: Array<{ type: string; url?: string }> }>) : [];
  return list.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
}

@Injectable()
export class PaymentSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly publisher: InboxPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly globals: GlobalAttributesService,
  ) {}

  linkBase(): string {
    return this.config.PUBLIC_LINK_BASE_URL ?? `${this.config.APP_URL.replace(/\/+$/, '')}/l`;
  }

  /** The index of a template's pay link button, or -1. */
  payLinkButton(template: Pick<Template, 'components'>): number {
    return payLinkButtonIndex(templateButtons(template.components) as never, this.linkBase());
  }

  /** The payment template set in the settings, when it can be sent from this number's account. */
  async paymentTemplate(settings: PaymentSettings, wabaId: string): Promise<Template | null> {
    if (!settings.templateId) return null;
    const template = await this.prisma.template.findUnique({ where: { id: settings.templateId } });
    if (!template || template.status !== 'APPROVED' || template.wabaId !== wabaId || this.payLinkButton(template) < 0) return null;
    return template;
  }

  /** The Pay now message's text from the settings. */
  async text(settings: PaymentSettings, row: PaymentRequest): Promise<string> {
    return fillSessionText(settings.sessionText, paymentWords(row, this.linkBase(), await this.timeZone()));
  }

  /** The Pay now message as a chat item: the request, the button and our link, with its summary. */
  outgoing(row: PaymentRequest, settings: PaymentSettings, text: string) {
    return {
      contentType: 'PAYMENT_REQUEST' as const,
      text,
      mediaAssetId: null,
      payload: { paymentRequestId: row.id, buttonText: settings.buttonText, url: chatSummary(row, this.linkBase()).payUrl, payment: chatSummary(row, this.linkBase()) },
    };
  }

  /** An automatic Pay now message (flows, chat orders): it does not take the chat. */
  async automatic(conversationId: string, numberId: string, row: PaymentRequest, settings: PaymentSettings): Promise<string> {
    const out = this.outgoing(row, settings, await this.text(settings, row));
    const id = uuidv7();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.chatMessage.create({
        data: { id, conversationId, kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType: out.contentType, text: out.text, payload: out.payload as Prisma.InputJsonValue, status: 'QUEUED', occurredAt: now },
      });
      await tx.$executeRaw`
        UPDATE conversations SET last_activity_at = GREATEST(last_activity_at, ${now}), last_message_preview = ${previewOf(out)}, updated_at = now()
         WHERE id = ${conversationId}::uuid`;
      await tx.paymentRequest.update({ where: { id: row.id }, data: { chatItemId: id } });
    });
    const job = sessionSendJob(id);
    await this.queues.sendQueue(numberId).add(job.name, job.data, job.opts);
    await requestSendWorkerSync(this.queues);
    await this.publisher.itemCreated(id);
    await this.publisher.conversation(conversationId);
    return id;
  }

  /**
   * The payment template outside the window (or for campaigns' and reminders' own templates): the
   * request's code goes in the pay link button, the other variables come from the mapping.
   */
  async template(
    target: { conversationId: string | null; numberId: string; contactId: string },
    row: PaymentRequest,
    template: Template,
    mappingJson: unknown,
    opts: { sentByUserId?: string | null; automatic?: boolean; origin?: 'PAYMENTS' | 'INBOX'; /** Reminders keep the request's first message (US4). */ keepLinks?: boolean } = {},
  ): Promise<{ messageId: string; chatItemId: string | null }> {
    const contact = await this.prisma.contact.findUniqueOrThrow({ where: { id: target.contactId }, select: { name: true, phoneE164: true, attributes: true, consentStatus: true, countryCode: true } });
    if (!contact.phoneE164) throw AppError.validation('This contact has no phone number');
    assertConsent(contact.consentStatus, template.category);
    const button = this.payLinkButton(template);
    if (button < 0) throw AppError.validation('The payment template needs a pay link button', [], 'TEMPLATE_NOT_PAY_LINK');
    const parsed = VariableMappingSchema.safeParse(mappingJson ?? {});
    const mapping = { ...(parsed.success ? parsed.data : {}), [`BUTTON.${button}.1`]: { source: 'payment' as const, key: 'code' } };
    const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
    const keys = variables.some((v) => v.key === `BUTTON.${button}.1`) ? variables : [...variables, { key: `BUTTON.${button}.1` }];
    const resolved = resolveVariables(keys, mapping, {
      contact: { name: contact.name, phone: contact.phoneE164, attributes: contact.attributes },
      row: {},
      globals: await this.globals.values(),
      payment: paymentWords(row, this.linkBase(), await this.timeZone()),
    });
    if (!resolved.ok) throw AppError.validation(`The payment template has variables without a value: ${resolved.missing.join(', ')}`, [], 'MISSING_VARIABLE');
    const now = new Date();
    const itemId = target.conversationId ? uuidv7() : null;
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          origin: opts.origin ?? 'PAYMENTS',
          automatic: opts.automatic ?? !opts.sentByUserId,
          contactId: target.contactId,
          phoneE164: contact.phoneE164,
          recipientCountry: contact.countryCode,
          numberId: target.numberId,
          templateId: template.id,
          resolvedParams: resolved.params as Prisma.InputJsonValue,
          status: 'QUEUED',
          queuedAt: now,
          sentByUserId: opts.sentByUserId ?? null,
        },
      });
      await tx.messageEvent.create({ data: { messageId: created.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${created.id}:queued` } });
      if (itemId && target.conversationId) {
        await tx.chatMessage.create({
          data: {
            id: itemId,
            conversationId: target.conversationId,
            kind: 'MESSAGE_REF',
            origin: opts.sentByUserId ? 'MEMBER' : 'AUTOMATIC',
            contentType: 'TEMPLATE',
            messageId: created.id,
            payload: { payment: chatSummary(row, this.linkBase()) } as Prisma.InputJsonValue,
            sentByUserId: opts.sentByUserId ?? null,
            occurredAt: now,
          },
        });
        await tx.$executeRaw`
          UPDATE conversations SET last_activity_at = GREATEST(last_activity_at, ${now}), last_message_preview = ${`Template: ${template.name}`.slice(0, 120)}, updated_at = now()
           WHERE id = ${target.conversationId}::uuid`;
      }
      if (!opts.keepLinks) await tx.paymentRequest.update({ where: { id: row.id }, data: { messageId: created.id, ...(itemId ? { chatItemId: itemId } : {}) } });
      return created;
    });
    const job = chatTemplateSendJob(message.id);
    await this.queues.sendQueue(target.numberId).add(job.name, job.data, job.opts);
    await requestSendWorkerSync(this.queues);
    if (itemId && target.conversationId) {
      await this.publisher.itemCreated(itemId);
      await this.publisher.conversation(target.conversationId);
    }
    return { messageId: message.id, chatItemId: itemId };
  }

  private async timeZone(): Promise<string> {
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    return settings?.defaultTimezone ?? 'UTC';
  }
}
