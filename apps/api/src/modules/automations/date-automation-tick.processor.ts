import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../common/queue/processor.registry.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { Prisma, type DateAutomation, type Template, type WhatsAppNumber } from '../../generated/prisma/client.js';
import { globalKeys, resolveVariables, VariableMappingSchema } from '../campaigns/variable-resolver.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { campaignSendJob, requestSendWorkerSync } from '../sending/send-jobs.js';
import { GlobalAttributesService } from '../settings/global-attributes.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { PauseReason } from './date-automations.service.js';
import { companyClock, dayDate, dayOf, dueCondition } from './due-query.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';

export const DATE_AUTOMATION_TICK_JOB = 'date-automation-tick';
const EVERY_MS = 60_000;
/** Contacts read per due query page, and messages made per batch (research R9). */
const DUE_PAGE = 5_000;
const BATCH = 500;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type SkipReason = 'opted_out' | 'blocked' | 'invalid' | 'no_date' | 'missing_value' | 'not_opted_in' | 'too_late';

const PAUSE_TEXT: Record<PauseReason, string> = {
  TEMPLATE_NOT_APPROVED: 'Its template is no longer approved. Choose an approved template, then switch the automation on again.',
  NUMBER_DISCONNECTED: 'Its WhatsApp number is not connected. Reconnect the number, then switch the automation on again.',
  SENDING_OFF: 'Sending is turned off for its WhatsApp number. Turn sending on, then switch the automation on again.',
};

type Automation = DateAutomation & { template: Template; number: WhatsAppNumber };
type DueContact = { name: string | null; phoneE164: string; countryCode: string; consentStatus: string; blockedAt: Date | null; attributes: Prisma.JsonValue };

/** Why an automation cannot run now, if it cannot (checked before each run). */
export function pauseReason(a: { template: { status: string }; number: { connectionStatus: string; sendingEnabled: boolean } }): PauseReason | null {
  if (a.template.status !== 'APPROVED') return 'TEMPLATE_NOT_APPROVED';
  if (a.number.connectionStatus !== 'CONNECTED') return 'NUMBER_DISCONNECTED';
  if (!a.number.sendingEnabled) return 'SENDING_OFF';
  return null;
}

/** Why a due contact gets no message, if not. */
export function skipReason(c: DueContact, attributeKey: string, marketing: boolean): SkipReason | null {
  if (c.blockedAt) return 'blocked';
  if (c.consentStatus === 'OPTED_OUT') return 'opted_out';
  if (!normalizePhone(c.phoneE164, c.countryCode)) return 'invalid';
  const value = (c.attributes as Record<string, unknown> | null)?.[attributeKey];
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return 'no_date';
  if (marketing && c.consentStatus !== 'OPTED_IN') return 'not_opted_in';
  return null;
}

/**
 * Feature 010 (US5, research R9): every minute, each automation that is ON and whose send time has passed
 * today (company time zone) records today's due contacts once (unique occurrences, so nobody is due twice)
 * and turns pending occurrences into DATE_AUTOMATION messages on the number's queue, 500 at a time.
 * Occurrences of earlier days still pending are skipped as `too_late`, so nothing goes out on a later day.
 */
@Injectable()
export class DateAutomationTickProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(DateAutomationTickProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly globals: GlobalAttributesService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, DATE_AUTOMATION_TICK_JOB, () => this.tick());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler(DATE_AUTOMATION_TICK_JOB, { every: EVERY_MS }, { name: DATE_AUTOMATION_TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async tick(now = new Date()): Promise<{ queued: number; skipped: number; paused: number }> {
    const clock = companyClock(now, (await this.settings.get()).defaultTimezone);
    const today = dayDate(clock.date);
    const late = await this.prisma.dateAutomationOccurrence.updateMany({ where: { status: 'PENDING', messageId: null, dueDate: { lt: today } }, data: { status: 'SKIPPED', reason: 'too_late' } });
    const automations = await this.prisma.dateAutomation.findMany({ where: { status: 'ON', sendTime: { lte: clock.time } }, include: { template: true, number: true }, orderBy: { id: 'asc' } });
    if (late.count) this.metrics.dateAutomationMessagesTotal.inc({ result: 'too_late' }, late.count);
    const totals = { queued: 0, skipped: late.count, paused: 0 };
    for (const a of automations) {
      try {
        const reason = pauseReason(a);
        if (reason) {
          if (await this.pause(a, reason)) totals.paused++;
          continue;
        }
        if (!a.lastRunDate || dayOf(a.lastRunDate) !== clock.date) {
          await this.recordDue(a, clock.date);
          await this.prisma.dateAutomation.update({ where: { id: a.id }, data: { lastRunDate: today } });
        }
        const done = await this.sendPending(a, clock.date);
        totals.queued += done.queued;
        totals.skipped += done.skipped;
        if (done.queued) this.metrics.dateAutomationMessagesTotal.inc({ result: 'queued' }, done.queued);
        if (done.skipped) this.metrics.dateAutomationMessagesTotal.inc({ result: 'skipped' }, done.skipped);
      } catch (error) {
        this.logger.error({ automationId: a.id, err: (error as Error).message }, 'Date automation run failed');
      }
    }
    await this.measureBehind(clock).catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not measure pending date automation messages'));
    return totals;
  }

  /** Occurrences still pending 30 minutes after their automation's send time today (WbmDateAutomationBehind). */
  private async measureBehind(clock: { date: string; time: string }): Promise<void> {
    const [h, m] = clock.time.split(':').map(Number) as [number, number];
    const minutes = h * 60 + m - 30;
    if (minutes < 0) {
      this.metrics.dateAutomationBehind.set(0);
      return;
    }
    const cutoff = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const behind = await this.prisma.dateAutomationOccurrence.count({ where: { status: 'PENDING', dueDate: dayDate(clock.date), automation: { status: 'ON', sendTime: { lte: cutoff } } } });
    this.metrics.dateAutomationBehind.set(behind);
  }

  /** Pauses an automation that cannot run, telling the admins once; returns whether it changed. */
  private async pause(a: Automation, reason: PauseReason): Promise<boolean> {
    const { count } = await this.prisma.dateAutomation.updateMany({ where: { id: a.id, status: 'ON' }, data: { status: 'PAUSED', pausedReason: reason } });
    if (!count) return false;
    await this.notifications.notifyAdmins({ type: 'DATE_AUTOMATION_PAUSED', title: `Date automation "${a.name}" is paused`, body: PAUSE_TEXT[reason], link: `/automations/${a.id}` });
    this.logger.warn({ automationId: a.id, reason }, 'Date automation paused');
    return true;
  }

  /** Today's due contacts as occurrences; conflicts are ignored, so a contact is due once per date. */
  private async recordDue(a: Automation, day: string): Promise<void> {
    const due = dueCondition(a.attributeKey, a.timing, a.offsetDays, day);
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const rows: Array<{ id: string }> = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT c.id FROM contacts c WHERE ${due} ${after} ORDER BY c.id LIMIT ${DUE_PAGE}`;
      if (!rows.length) return;
      await this.prisma.dateAutomationOccurrence.createMany({ data: rows.map((r) => ({ id: uuidv7(), automationId: a.id, contactId: r.id, dueDate: dayDate(day) })), skipDuplicates: true });
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < DUE_PAGE) return;
    }
  }

  /** Pending occurrences of today become messages or skips, 500 at a time. */
  private async sendPending(a: Automation, day: string): Promise<{ queued: number; skipped: number }> {
    const parsed = VariableMappingSchema.safeParse(a.variableMapping);
    const mapping = parsed.success ? parsed.data : {};
    const variables = (Array.isArray(a.template.variables) ? a.template.variables : []) as Array<{ key: string; example?: string }>;
    const globals = globalKeys(mapping).length ? await this.globals.values() : {};
    const marketing = a.template.category === 'MARKETING';
    const totals = { queued: 0, skipped: 0 };
    let cursor: string | null = null;
    for (;;) {
      const where: Prisma.DateAutomationOccurrenceWhereInput = { automationId: a.id, dueDate: dayDate(day), status: 'PENDING', messageId: null, ...(cursor ? { id: { gt: cursor } } : {}) };
      const batch = await this.prisma.dateAutomationOccurrence.findMany({
        where,
        include: { contact: { select: { name: true, phoneE164: true, countryCode: true, consentStatus: true, blockedAt: true, attributes: true } } },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1]!.id;
      const queued: string[] = [];
      for (const o of batch) {
        const c = o.contact;
        let reason: SkipReason | null = skipReason(c, a.attributeKey, marketing);
        const resolved = reason ? null : resolveVariables(variables, mapping, { contact: { name: c.name, phone: c.phoneE164, attributes: c.attributes }, row: {}, globals });
        if (resolved && !resolved.ok) reason = 'missing_value';
        if (reason || !resolved?.ok) {
          const { count } = await this.prisma.dateAutomationOccurrence.updateMany({ where: { id: o.id, status: 'PENDING', messageId: null }, data: { status: 'SKIPPED', reason } });
          totals.skipped += count;
          continue;
        }
        const messageId = uuidv7();
        const now = new Date();
        const claimed = await this.prisma.$transaction(async (tx) => {
          await tx.message.create({
            data: {
              id: messageId,
              origin: 'DATE_AUTOMATION',
              contactId: o.contactId,
              phoneE164: c.phoneE164,
              recipientCountry: c.countryCode,
              numberId: a.numberId,
              templateId: a.templateId,
              resolvedParams: resolved.params as Prisma.InputJsonValue,
              status: 'QUEUED',
              queuedAt: now,
            },
          });
          await tx.messageEvent.create({ data: { messageId, type: 'QUEUED', occurredAt: now, dedupeKey: `${messageId}:queued` } });
          const { count } = await tx.dateAutomationOccurrence.updateMany({ where: { id: o.id, status: 'PENDING', messageId: null }, data: { messageId } });
          // Another run took this occurrence first: undo the message.
          if (!count) throw new OccurrenceTaken();
          return true;
        }).catch((error: unknown) => {
          if (error instanceof OccurrenceTaken) return false;
          throw error;
        });
        if (claimed) queued.push(messageId);
      }
      if (queued.length) {
        const queue = this.queues.sendQueue(a.numberId);
        await queue.addBulk(queued.map((id) => campaignSendJob(id)).map((job) => ({ name: job.name, data: job.data, opts: job.opts })));
        totals.queued += queued.length;
      }
      if (batch.length < BATCH) break;
    }
    if (totals.queued) await requestSendWorkerSync(this.queues);
    return totals;
  }
}

class OccurrenceTaken extends Error {}
