import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { extractTemplateVariables, isQuietAt, type MetaTemplateComponent } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { resolveVariables, type VariableMapping } from '../../campaigns/variable-resolver.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { sendJobId } from '../../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../../sending/send-outcome.js';
import { HEADER_MEDIA_ASSET_PARAM } from '../../sending/template-send-rules.js';
import { TrackedLinkCodes } from '../links/link-codes.js';
import { DripEvents } from './drip-events.js';
import { quietHoursOf } from './drip-views.js';

// The drip tick (feature 005 US4, research R7): every 30 seconds, for each active drip outside its
// quiet hours, claim the enrolments whose step is due (FOR UPDATE SKIP LOCKED, in batches of 500),
// check them again, write the step message and the step record in the same transaction, move the
// contact on, and hand the messages to the number's send queue (shared with campaigns, after live
// chat). Leaving events lock the same rows, so no step goes out after a contact left (SC-006).

const TICK_MS = 30_000;
const BATCH = 500;
/** At most this many batches per drip per tick, so one large drip cannot hold up the others. */
const MAX_BATCHES = 20;

type DripWithSteps = Prisma.DripGetPayload<{
  include: {
    number: true;
    steps: { include: { template: true; trackedLinkTargets: true } };
  };
}>;

export interface DripTickSummary {
  enrolled: number;
  sent: number;
  skipped: number;
  finished: number;
  left: number;
  paused: number;
}

type PauseReason = 'TEMPLATE_UNAVAILABLE' | 'NUMBER_DISCONNECTED';

const PAUSE_TEXT: Record<PauseReason, string> = {
  TEMPLATE_UNAVAILABLE: 'a step template is paused, disabled or not approved',
  NUMBER_DISCONNECTED: 'its WhatsApp number is disconnected or sending is turned off',
};

@Injectable()
export class DripTickProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(DripTickProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly codes: TrackedLinkCodes,
    private readonly notifications: NotificationsService,
    private readonly events: DripEvents,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.DRIPS, 'drip-tick', () => this.tick());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.DRIPS)
      .upsertJobScheduler('drip-tick', { every: TICK_MS }, { name: 'drip-tick', opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async tick(): Promise<DripTickSummary> {
    const summary: DripTickSummary = { enrolled: 0, sent: 0, skipped: 0, finished: 0, left: 0, paused: 0 };
    // Starting events first, so a contact who just joined can get a step due right away (US5).
    summary.enrolled = await this.events.consume();
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    const timezone = settings?.defaultTimezone ?? 'UTC';
    const drips = await this.prisma.drip.findMany({
      where: { status: 'ACTIVE' },
      include: { number: true, steps: { where: { deletedAt: null }, orderBy: { position: 'asc' }, include: { template: true, trackedLinkTargets: true } } },
    });
    for (const drip of drips) {
      // Steps due in quiet hours wait until sending may start, in their order (FR-021).
      if (isQuietAt(quietHoursOf(drip), timezone, new Date())) continue;
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const outcome = await this.runBatch(drip, summary);
        if (outcome === 'paused') {
          summary.paused += 1;
          break;
        }
        if (outcome < BATCH) break;
      }
    }
    return summary;
  }

  /** Claims and handles up to one batch of due enrolments. Returns how many were claimed, or 'paused'. */
  private async runBatch(drip: DripWithSteps, summary: DripTickSummary): Promise<number | 'paused'> {
    const queued: string[] = [];
    const state: { pause: PauseReason | null } = { pause: null };
    const claimed = await this.prisma.$transaction(
      async (tx) => {
        const due = await tx.$queryRaw<Array<{ id: string; contact_id: string | null; current_position: number }>>`
          SELECT id, contact_id, current_position FROM drip_enrolments
           WHERE drip_id = ${drip.id}::uuid AND status = 'ACTIVE' AND next_due_at <= now()
           ORDER BY next_due_at
           LIMIT ${BATCH}
           FOR UPDATE SKIP LOCKED`;
        if (!due.length) return 0;
        if (drip.number.connectionStatus !== 'CONNECTED' || !drip.number.sendingEnabled) {
          state.pause = 'NUMBER_DISCONNECTED';
          await tx.drip.updateMany({ where: { id: drip.id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedReason: state.pause, pausedAt: new Date() } });
          return due.length;
        }
        const contacts = new Map(
          (
            await tx.contact.findMany({
              where: { id: { in: due.flatMap((e) => (e.contact_id ? [e.contact_id] : [])) } },
              select: { id: true, phoneE164: true, countryCode: true, name: true, attributes: true, consentStatus: true, blockedAt: true },
            })
          ).map((c) => [c.id, c]),
        );
        const now = new Date();
        for (const enrolment of due) {
          const step = drip.steps.find((s) => s.position === enrolment.current_position);
          if (!step) {
            await this.end(tx, enrolment.id, 'FINISHED', null);
            summary.finished += 1;
            continue;
          }
          const contact = enrolment.contact_id ? contacts.get(enrolment.contact_id) : undefined;
          // Leaving events end enrolments at once; these checks catch anything they missed.
          const leftReason = !contact ? 'DELETED' : contact.consentStatus === 'OPTED_OUT' ? 'OPTED_OUT' : contact.blockedAt ? 'BLOCKED' : null;
          if (!contact || leftReason) {
            await this.end(tx, enrolment.id, 'LEFT', leftReason ?? 'DELETED');
            summary.left += 1;
            continue;
          }
          if (step.template.status !== 'APPROVED' || step.template.wabaId !== drip.number.wabaId) {
            state.pause = 'TEMPLATE_UNAVAILABLE';
            break;
          }

          const skipReason = await this.sendStep(tx, drip, step, enrolment.id, contact, now, queued);
          if (skipReason) {
            await tx.dripStepSend.create({ data: { enrolmentId: enrolment.id, stepId: step.id, outcome: 'SKIPPED', skipReason } });
            summary.skipped += 1;
          } else {
            summary.sent += 1;
          }
          // Move on: the next live step after its wait, or finished.
          const next = drip.steps.find((s) => s.position === enrolment.current_position + 1);
          if (next) {
            await tx.dripEnrolment.update({
              where: { id: enrolment.id },
              data: { currentPosition: next.position, nextDueAt: new Date(now.getTime() + next.waitMinutes * 60_000) },
            });
          } else {
            await this.end(tx, enrolment.id, 'FINISHED', null, enrolment.current_position + 1);
            summary.finished += 1;
          }
        }
        if (state.pause) {
          await tx.drip.updateMany({ where: { id: drip.id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedReason: state.pause, pausedAt: now } });
        }
        return due.length;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    for (const messageId of queued) await this.enqueue(drip.numberId, messageId);
    if (state.pause) {
      await this.alertPaused(drip, state.pause);
      return 'paused';
    }
    return claimed;
  }

  /** Writes the step's message; returns why the step is skipped instead (FR-029). */
  private async sendStep(
    tx: Prisma.TransactionClient,
    drip: DripWithSteps,
    step: DripWithSteps['steps'][number],
    enrolmentId: string,
    contact: { id: string; phoneE164: string; countryCode: string; name: string | null; attributes: unknown; consentStatus: string },
    now: Date,
    queued: string[],
  ): Promise<string | null> {
    // A marketing template needs an opt-in: without one the step is skipped and the contact moves on.
    if (step.template.category === 'MARKETING' && contact.consentStatus !== 'OPTED_IN') return 'NO_OPT_IN';
    const components = step.template.components as unknown as MetaTemplateComponent[];
    const targets = step.trackedLinkTargets;
    const trackedKeys = new Set(targets.map((t) => t.variableKey));
    const variables = extractTemplateVariables(components).filter((v) => !trackedKeys.has(v.key));
    const resolved = resolveVariables(variables, (step.variableMapping ?? {}) as VariableMapping, {
      contact: { name: contact.name, phone: contact.phoneE164, attributes: contact.attributes },
      row: {},
    });
    if (!resolved.ok) return 'MISSING_VARIABLE';

    const messageId = uuidv7();
    const plan = targets.length ? this.codes.plan([{ id: messageId, contactId: contact.id }], targets) : null;
    await tx.message.create({
      data: {
        id: messageId,
        origin: 'DRIP',
        contactId: contact.id,
        phoneE164: contact.phoneE164,
        recipientCountry: contact.countryCode,
        numberId: drip.numberId,
        templateId: step.templateId,
        resolvedParams: {
          ...resolved.params,
          ...(plan?.params.get(messageId) ?? {}),
          ...(step.headerMediaAssetId ? { [HEADER_MEDIA_ASSET_PARAM]: step.headerMediaAssetId } : {}),
        } as Prisma.InputJsonValue,
        status: 'QUEUED',
        queuedAt: now,
        dripEnrolmentId: enrolmentId,
        dripStepId: step.id,
      },
    });
    await tx.messageEvent.create({ data: { messageId, type: 'QUEUED', occurredAt: now, dedupeKey: `${messageId}:queued` } });
    if (plan) await this.codes.save(tx, plan.links, targets);
    await tx.dripStepSend.create({ data: { enrolmentId, stepId: step.id, outcome: 'QUEUED', messageId } });
    queued.push(messageId);
    return null;
  }

  private async end(tx: Prisma.TransactionClient, enrolmentId: string, status: 'FINISHED' | 'LEFT', reason: 'DELETED' | 'OPTED_OUT' | 'BLOCKED' | null, position?: number) {
    await tx.dripEnrolment.update({
      where: { id: enrolmentId },
      data: { status, leftReason: reason, endedAt: new Date(), nextDueAt: null, ...(position ? { currentPosition: position } : {}) },
    });
  }

  /** Hands a drip message to the number's send queue, like an API message (001 send worker). */
  private async enqueue(numberId: string, messageId: string): Promise<void> {
    try {
      await this.queues.sendQueue(numberId).add('send', { messageId }, {
        jobId: sendJobId(messageId),
        attempts: MAX_SEND_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      });
    } catch (error) {
      this.logger.error({ err: error, messageId }, 'Could not queue a drip message');
      await this.prisma.message.updateMany({ where: { id: messageId, status: 'QUEUED' }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
    }
  }

  /** The drip paused itself (FR-032): admins and managers are told why. */
  private async alertPaused(drip: DripWithSteps, reason: PauseReason): Promise<void> {
    this.logger.warn({ dripId: drip.id, reason }, 'Drip paused itself');
    const members = await this.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'MANAGER'] }, status: 'ACTIVE' }, select: { id: true } });
    await this.notifications.notifyUsers(
      members.map((m) => m.id),
      {
        type: 'DRIP_PAUSED',
        title: 'Drip paused',
        body: `"${drip.name}" paused itself because ${PAUSE_TEXT[reason]}. Fix it, then resume the drip.`,
        link: `/drips/${drip.id}`,
      },
    );
  }
}
