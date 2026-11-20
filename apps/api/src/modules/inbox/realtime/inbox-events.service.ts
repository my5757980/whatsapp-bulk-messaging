import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { InboxEventEnvelope } from './event-filter.js';

/** The Redis Stream every live chat change is appended to (research R1, data-model §5). */
export const INBOX_STREAM = 'wbm:inbox:events';
/** About a day of events at the expected volume; older IDs make clients resync. */
export const INBOX_STREAM_MAXLEN = 20_000;
/** The stream entry field holding the JSON envelope. */
export const INBOX_STREAM_FIELD = 'e';

export type InboxEventInput = Omit<InboxEventEnvelope, 'at'> & { at?: string };

/**
 * Publishes live chat events (T018). Call it after the database change has committed. It is best
 * effort: a Redis failure is logged and never fails the webhook, send or request that caused it,
 * because clients recover with `resync` and REST.
 */
@Injectable()
export class InboxEventsService {
  private readonly logger = new Logger(InboxEventsService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Returns the stream entry ID (the SSE event ID), or null when Redis refused it. */
  async publish(event: InboxEventInput): Promise<string | null> {
    const envelope: InboxEventEnvelope = { ...event, at: event.at ?? new Date().toISOString() };
    try {
      return await this.redis.xadd(INBOX_STREAM, 'MAXLEN', '~', INBOX_STREAM_MAXLEN, '*', INBOX_STREAM_FIELD, JSON.stringify(envelope));
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, type: event.type, conversationId: event.conversationId }, 'Could not publish a live chat event');
      return null;
    }
  }
}

/** Reads the envelope back from a stream entry's field list; null for foreign or broken entries. */
export function decodeStreamEntry(fields: readonly string[]): InboxEventEnvelope | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== INBOX_STREAM_FIELD) continue;
    try {
      return JSON.parse(fields[i + 1]!) as InboxEventEnvelope;
    } catch {
      return null;
    }
  }
  return null;
}

/** Orders Redis stream IDs ("<ms>-<seq>"); negative when a is older than b. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const ms = BigInt(aMs) - BigInt(bMs);
  if (ms !== 0n) return ms < 0n ? -1 : 1;
  const seq = BigInt(aSeq) - BigInt(bSeq);
  return seq === 0n ? 0 : seq < 0n ? -1 : 1;
}

/** True for well-formed stream IDs; anything else from a client is ignored. */
export function isStreamId(value: string | undefined): value is string {
  return value !== undefined && /^\d{1,20}-\d{1,20}$/.test(value);
}
