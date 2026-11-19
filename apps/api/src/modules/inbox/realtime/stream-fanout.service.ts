import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { SESSION_IDLE_MS } from '../../auth/auth.service.js';
import { AgentRulesLoader } from '../conversations/agent-rules.loader.js';
import { seesAll, type AgentRuleFacts, type Viewer } from '../conversations/visibility.js';
import { decideDelivery, type ContactFacts, type InboxEventEnvelope } from './event-filter.js';
import {
  compareStreamIds,
  decodeStreamEntry,
  INBOX_STREAM,
  isStreamId,
} from './inbox-events.service.js';

export const INBOX_STREAM_OPTIONS = Symbol('INBOX_STREAM_OPTIONS');

export interface InboxStreamOptions {
  /** Heartbeat comment interval (contract: 15 s). */
  pingMs: number;
  /** Presence key lifetime; push alerts are skipped while it exists (research R9). */
  presenceTtlSeconds: number;
  /** Re-check the session every N pings, so signed-out or deactivated users stop receiving events. */
  revalidateEveryPings: number;
}

export const DEFAULT_INBOX_STREAM_OPTIONS: InboxStreamOptions = {
  pingMs: 15_000,
  presenceTtlSeconds: 45,
  revalidateEveryPings: 4,
};

export const presenceKey = (userId: string) => `wbm:presence:${userId}`;

const CONTACT_FACTS_CACHE_MS = 30_000;
const REPLAY_BATCH = 500;
const READ_BATCH = 200;
/** A client this far behind is dropped; its EventSource reconnects and replays. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** One open `GET /inbox/events` response, as the controller hands it over. */
export interface StreamClient {
  viewer: Viewer;
  sessionTokenHash: string;
  write(chunk: string): void;
  bufferedBytes(): number;
  end(): void;
  onClose(listener: () => void): void;
}

interface Connection {
  client: StreamClient;
  /** Copy of the viewer; the role is refreshed when the session is re-checked. */
  viewer: Viewer;
  /** Live events held back while the replay runs; null once live. */
  pending: Array<{ id: string; envelope: InboxEventEnvelope }> | null;
  /** Newest stream ID handled for this connection (sent or filtered out). */
  lastId: string | null;
  closed: boolean;
}

/**
 * Fans the live chat stream out to this instance's open connections (T019, research R1): one
 * blocking XREAD tail per instance, per-connection filtering and masking, Last-Event-ID replay,
 * heartbeats and the presence key used to skip push alerts.
 */
@Injectable()
export class StreamFanoutService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamFanoutService.name);
  private readonly connections = new Set<Connection>();
  private readonly contactFacts = new Map<
    string,
    { facts: ContactFacts | null; expires: number }
  >();
  private reader: Redis | null = null;
  private readerReady: Promise<void> | null = null;
  private cursor = '0-0';
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private stopped = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly rules: AgentRulesLoader,
    @Inject(INBOX_STREAM_OPTIONS) private readonly options: InboxStreamOptions,
  ) {}

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Registers the client, replays what it missed and switches it to live events. */
  async attach(client: StreamClient, lastEventId: string | undefined): Promise<void> {
    const conn: Connection = {
      client,
      viewer: { ...client.viewer },
      pending: [],
      lastId: null,
      closed: false,
    };
    this.connections.add(conn);
    client.onClose(() => this.detach(conn));
    try {
      await this.ensureReader();
      this.ensureTimer();
      await this.touchPresence(conn.viewer.id);
      if (isStreamId(lastEventId)) await this.replay(conn, lastEventId);
      // Drain what arrived meanwhile, then go live with no await in between, so order holds.
      while (conn.pending && conn.pending.length && !conn.closed) {
        const { id, envelope } = conn.pending.shift()!;
        if (conn.lastId && compareStreamIds(id, conn.lastId) <= 0) continue;
        await this.deliver(conn, id, envelope, await this.factsFor(envelope));
      }
      conn.pending = null;
      this.write(conn, ': connected\n\n');
    } catch (error) {
      this.close(conn);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const conn of [...this.connections]) this.close(conn);
    this.reader?.disconnect();
    this.reader = null;
  }

  // ---------- stream reading ----------

  private async ensureReader(): Promise<void> {
    if (!this.readerReady) {
      this.readerReady = (async () => {
        // Start from the newest entry, so nothing published after a client connects is missed.
        const [newest] = await this.redis.xrevrange(INBOX_STREAM, '+', '-', 'COUNT', 1);
        this.cursor = newest?.[0] ?? '0-0';
        this.reader = this.redis.duplicate(); // XREAD BLOCK needs its own connection
        void this.readLoop(this.reader);
      })();
      this.readerReady.catch(() => {
        this.readerReady = null; // retried by the next client
      });
    }
    await this.readerReady;
  }

  private async readLoop(reader: Redis): Promise<void> {
    while (!this.stopped) {
      try {
        const result = (await reader.xread(
          'COUNT',
          READ_BATCH,
          'BLOCK',
          5_000,
          'STREAMS',
          INBOX_STREAM,
          this.cursor,
        )) as Array<[string, Array<[string, string[]]>]> | null;
        for (const [, entries] of result ?? []) {
          for (const [id, fields] of entries) {
            this.cursor = id;
            const envelope = decodeStreamEntry(fields);
            if (envelope) await this.dispatch(id, envelope);
          }
        }
      } catch (error) {
        if (this.stopped) break;
        this.logger.warn(
          { err: (error as Error).message },
          'Live chat stream read failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async dispatch(id: string, envelope: InboxEventEnvelope): Promise<void> {
    if (envelope.type === 'contact.updated' && envelope.contactId)
      this.contactFacts.delete(envelope.contactId);
    let facts: ContactFacts | null | undefined;
    for (const conn of [...this.connections]) {
      if (conn.closed) continue;
      if (conn.pending) {
        conn.pending.push({ id, envelope });
        continue;
      }
      facts ??= await this.factsFor(envelope);
      await this.deliver(conn, id, envelope, facts);
    }
  }

  /** Sends what the client missed after `lastEventId`, or asks it to resync when that ID is gone. */
  private async replay(conn: Connection, lastEventId: string): Promise<void> {
    const [oldest] = await this.redis.xrange(INBOX_STREAM, '-', '+', 'COUNT', 1);
    const [newest] = await this.redis.xrevrange(INBOX_STREAM, '+', '-', 'COUNT', 1);
    if (
      !oldest ||
      !newest ||
      compareStreamIds(lastEventId, oldest[0]) < 0 ||
      compareStreamIds(lastEventId, newest[0]) > 0
    ) {
      this.write(conn, 'event: resync\ndata: {}\n\n');
      return;
    }
    let start = `(${lastEventId}`;
    for (;;) {
      const batch = await this.redis.xrange(INBOX_STREAM, start, '+', 'COUNT', REPLAY_BATCH);
      for (const [id, fields] of batch) {
        if (conn.closed) return;
        const envelope = decodeStreamEntry(fields);
        if (envelope) await this.deliver(conn, id, envelope, await this.factsFor(envelope));
        conn.lastId = id;
      }
      if (batch.length < REPLAY_BATCH) return;
      start = `(${batch[batch.length - 1]![0]}`;
    }
  }

  // ---------- delivery ----------

  private async deliver(
    conn: Connection,
    id: string,
    envelope: InboxEventEnvelope,
    facts: ContactFacts | null,
  ): Promise<void> {
    if (conn.closed) return;
    conn.lastId = id;
    let rules: AgentRuleFacts[] = [];
    if (!seesAll(conn.viewer)) {
      try {
        rules = await this.rules.forUser(conn.viewer.id);
      } catch (error) {
        // Without the rules the event cannot be checked, so this agent does not get it.
        this.logger.warn(
          { err: (error as Error).message, userId: conn.viewer.id },
          'Could not load agent rules for a live event',
        );
        return;
      }
    }
    const decision = decideDelivery(conn.viewer, rules, facts, envelope);
    if (decision.send)
      this.write(
        conn,
        `id: ${id}\nevent: ${decision.event}\ndata: ${JSON.stringify(decision.data)}\n\n`,
      );
  }

  /** Contact tags and attributes for agent rules, cached briefly and dropped on contact.updated. */
  private async factsFor(envelope: InboxEventEnvelope): Promise<ContactFacts | null> {
    const contactId = envelope.contactId;
    if (!contactId) return null;
    const hit = this.contactFacts.get(contactId);
    if (hit && hit.expires > Date.now()) return hit.facts;
    let row: { attributes: unknown; tags: Array<{ tagId: string }> } | null;
    try {
      row = await this.prisma.contact.findUnique({
        where: { id: contactId },
        select: { attributes: true, tags: { select: { tagId: true } } },
      });
    } catch (error) {
      // Unknown facts match no agent rule; admins, managers and owners still get the event.
      this.logger.warn(
        { err: (error as Error).message, contactId },
        'Could not load contact facts for a live event',
      );
      return null;
    }
    const facts = row
      ? {
          tagIds: row.tags.map((t) => t.tagId),
          attributes: (row.attributes ?? {}) as Record<string, unknown>,
        }
      : null;
    this.contactFacts.set(contactId, { facts, expires: Date.now() + CONTACT_FACTS_CACHE_MS });
    return facts;
  }

  private write(conn: Connection, chunk: string): void {
    if (conn.closed) return;
    if (conn.client.bufferedBytes() > MAX_BUFFERED_BYTES) {
      this.logger.warn(
        { userId: conn.viewer.id },
        'Live chat client too far behind; closing its stream',
      );
      this.close(conn);
      return;
    }
    conn.client.write(chunk);
  }

  // ---------- heartbeat, presence and session checks ----------

  private ensureTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.options.pingMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    const users = new Set<string>();
    for (const conn of [...this.connections]) {
      this.write(conn, ': ping\n\n');
      if (!conn.closed) users.add(conn.viewer.id);
    }
    await Promise.all([...users].map((userId) => this.touchPresence(userId)));
    if (this.ticks % this.options.revalidateEveryPings === 0) await this.revalidate();
  }

  /** Closes streams whose session ended; never extends the session's idle timeout. */
  private async revalidate(): Promise<void> {
    const now = Date.now();
    for (const conn of [...this.connections]) {
      try {
        const session = await this.prisma.session.findUnique({
          where: { tokenHash: conn.client.sessionTokenHash },
          select: {
            expiresAt: true,
            lastSeenAt: true,
            user: { select: { status: true, role: true } },
          },
        });
        const valid =
          session !== null &&
          session.expiresAt.getTime() > now &&
          session.lastSeenAt.getTime() + SESSION_IDLE_MS > now &&
          session.user.status === 'ACTIVE';
        if (!valid) this.close(conn);
        else conn.viewer.role = session.user.role;
      } catch (error) {
        this.logger.warn(
          { err: (error as Error).message },
          'Could not re-check a live chat session',
        );
      }
    }
  }

  private async touchPresence(userId: string): Promise<void> {
    await this.redis
      .set(presenceKey(userId), '1', 'EX', this.options.presenceTtlSeconds)
      .catch(() => undefined);
  }

  private close(conn: Connection): void {
    const wasOpen = !conn.closed;
    this.detach(conn);
    if (wasOpen) conn.client.end();
  }

  private detach(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    const stillHere = [...this.connections].some((other) => other.viewer.id === conn.viewer.id);
    // Other instances re-set the key within one ping if the user is connected there.
    if (!stillHere) void this.redis.del(presenceKey(conn.viewer.id)).catch(() => undefined);
    if (this.connections.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
