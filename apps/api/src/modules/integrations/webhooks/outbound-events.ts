import { Injectable, Logger } from '@nestjs/common';
import { buildEvent, type EventType } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';

// The outbound event writer (feature 006, research R2). A change that raises an event calls
// `record` inside its own transaction: one `outbound_events` row and one `webhook_deliveries` row per
// endpoint that chose the type. Nothing is written when no endpoint listens. The first attempt is
// queued at once with a short delay, so the change has committed by then. The sweep catches a job
// lost on the way, and a job that finds no row (a change rolled back) does nothing.

type Db = Prisma.TransactionClient | PrismaService;

export const DELIVER_JOB = 'deliver';
export const SWEEP_JOB = 'sweep';
export interface DeliverJobData {
  deliveryId: string;
  /** The attempt this job is for (attempts made so far); a job for an older attempt is stale. */
  attempt: number;
  /** How many times the job found no row yet (the change may not have committed). */
  waitingForRow?: number;
}

/** The first attempt waits this long after the event, so the triggering transaction has committed. */
export const FIRST_ATTEMPT_DELAY_MS = 1_000;
/**
 * How long the cached subscriptions are used before a cheap check of the endpoints table (count and
 * newest change). Endpoints change in the API process while the worker writes most events, so this
 * bounds how long another process can miss a new, changed or deleted endpoint (research R2).
 */
const CHECK_MS = 1_000;

/** One BullMQ job per attempt; deferrals add a suffix so they never collide with the attempt's job. */
export function deliverJobId(deliveryId: string, attempt: number, suffix = ''): string {
  return `wh-${deliveryId}-${attempt}${suffix ? `-${suffix}` : ''}`;
}

interface Subscriber {
  id: string;
  includeContent: boolean;
}

@Injectable()
export class OutboundEvents {
  private readonly logger = new Logger(OutboundEvents.name);
  private cache: { checkedAt: number; version: string; byType: Map<string, Subscriber[]> } | null = null;
  /** One shared load for callers outside a transaction. */
  private loading: Promise<Map<string, Subscriber[]>> | null = null;
  /** Bumped by invalidate(), so a load that started before a change is not cached. */
  private generation = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Forgets the cached subscriptions (called when endpoints are added, changed or deleted). */
  invalidate(): void {
    this.cache = null;
    this.loading = null;
    this.generation += 1;
  }

  /**
   * True when at least one endpoint chose the type, so callers can skip building a payload. Pass the
   * caller's transaction: a cold cache is then read on it, never on a second pool connection.
   */
  async listens(type: EventType, db?: Db): Promise<boolean> {
    return (await this.subscribers(type, db)).length > 0;
  }

  /**
   * Records an event for every endpoint that chose its type, in the caller's transaction. Returns
   * the ids of deliveries due now (endpoints that are not paused).
   */
  async record(db: Db, type: EventType, data: Record<string, unknown>, occurredAt = new Date()): Promise<string[]> {
    const subscribers = await this.subscribers(type, db);
    if (!subscribers.length) return [];
    // Content is kept only when at least one endpoint wants it (FR-009).
    const stored = buildEvent(type, data, subscribers.some((s) => s.includeContent));
    const eventId = uuidv7();
    await db.outboundEvent.create({ data: { id: eventId, type, occurredAt, data: stored as Prisma.InputJsonValue } });
    const ids = subscribers.map(() => uuidv7());
    // Endpoints deleted since the cache was read get no row (and cause no foreign-key error in the
    // caller's transaction); paused ones get a waiting row without a due time.
    const rows = await db.$queryRaw<Array<{ id: string; due: boolean }>>`
      INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempts, next_attempt_at, created_at, updated_at)
      SELECT d.id, d.endpoint_id, ${eventId}::uuid, 'PENDING', 0, CASE WHEN e.status = 'ACTIVE' THEN now() END, now(), now()
        FROM unnest(${ids}::uuid[], ${subscribers.map((s) => s.id)}::uuid[]) AS d(id, endpoint_id)
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
      RETURNING id, next_attempt_at IS NOT NULL AS due`;
    const due = rows.filter((r) => r.due).map((r) => r.id);
    for (const id of due) this.enqueue(id, 0, FIRST_ATTEMPT_DELAY_MS);
    return due;
  }

  /** Queues one attempt (fire and forget; a lost job is re-added by the sweep). */
  enqueue(deliveryId: string, attempt: number, delayMs = 0, suffix = '', waitingForRow = 0): void {
    const data: DeliverJobData = { deliveryId, attempt, ...(waitingForRow ? { waitingForRow } : {}) };
    this.queues
      .get(QUEUES.WEBHOOKS_OUT)
      .add(DELIVER_JOB, data, { jobId: deliverJobId(deliveryId, attempt, suffix), delay: Math.max(0, delayMs), attempts: 1, removeOnComplete: true, removeOnFail: 100 })
      .catch((error: unknown) => this.logger.warn({ err: error, deliveryId }, 'Could not queue a webhook delivery; the sweep will retry'));
  }

  private async subscribers(type: EventType, db?: Db): Promise<Subscriber[]> {
    const cached = this.cache;
    if (cached && Date.now() - cached.checkedAt <= CHECK_MS) return cached.byType.get(type) ?? [];
    if (cached && (await this.version(db ?? this.prisma)) === cached.version) {
      cached.checkedAt = Date.now();
      return cached.byType.get(type) ?? [];
    }
    // Inside a transaction the read uses its connection: waiting for another one from a busy pool
    // could hold the transaction until it times out.
    const byType =
      db && db !== this.prisma
        ? await this.load(db)
        : await (this.loading ??= this.load(this.prisma).finally(() => {
            this.loading = null;
          }));
    return byType.get(type) ?? [];
  }

  /** Changes whenever an endpoint is added, changed or deleted. */
  private async version(db: Db): Promise<string> {
    const [row] = await db.$queryRaw<Array<{ n: number; at: Date | null }>>`SELECT count(*)::int AS n, max(updated_at) AS at FROM webhook_endpoints`;
    return `${row?.n ?? 0}:${row?.at?.getTime() ?? 0}`;
  }

  private async load(db: Db): Promise<Map<string, Subscriber[]>> {
    const generation = this.generation;
    // The version is read first: a change between the two reads only causes one more load later.
    const version = await this.version(db);
    const endpoints = await db.webhookEndpoint.findMany({ select: { id: true, eventTypes: true, includeContent: true } });
    const byType = new Map<string, Subscriber[]>();
    for (const endpoint of endpoints) {
      for (const t of endpoint.eventTypes) byType.set(t, [...(byType.get(t) ?? []), { id: endpoint.id, includeContent: endpoint.includeContent }]);
    }
    if (generation === this.generation) this.cache = { checkedAt: Date.now(), version, byType };
    return byType;
  }
}
