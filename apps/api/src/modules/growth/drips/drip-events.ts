import { Injectable } from '@nestjs/common';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { Prisma, type DripTriggerKind } from '../../../generated/prisma/client.js';
import { DripLeaving } from './drip-leaving.js';

type Db = PrismaService | Prisma.TransactionClient;

/** At most this many events are turned into enrolments per tick. */
const CONSUME_BATCH = 5_000;
/** Events older than this are dropped by retention (research R12). */
export const DRIP_EVENT_TTL_MS = 24 * 3_600_000;

/**
 * Starting events (feature 005 US5, FR-024 - FR-027, research R8). The writers run inside the
 * transaction of the change that caused the event (a tag added, an opt-in, a new contact, a click),
 * so a rolled-back change writes nothing; they write only when an active drip listens to that kind,
 * so events of draft or paused drips are never replayed. The drip tick turns events into enrolments
 * and deletes them. Stop tags and clicks on a drip's own links also apply its leaving rules here.
 */
@Injectable()
export class DripEvents {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leaving: DripLeaving,
    private readonly metrics: MetricsService,
  ) {}

  /** Tags newly added to a contact, by anyone or anything (members, bulk actions, imports, flows). */
  async recordTagsAdded(db: Db, contactId: string, tagIds: readonly string[]): Promise<void> {
    if (!tagIds.length) return;
    await this.leaving.onEvent(contactId, { kind: 'TAGS_ADDED', tagIds }, db);
    await db.$executeRaw`
      INSERT INTO drip_events (kind, contact_id, tag_id, occurred_at)
      SELECT DISTINCT 'TAG_ADDED'::"DripTriggerKind", ${contactId}::uuid, t.tag_id, now()
        FROM drip_triggers t JOIN drips d ON d.id = t.drip_id AND d.status = 'ACTIVE'
       WHERE t.kind = 'TAG_ADDED' AND t.tag_id = ANY(${[...tagIds]}::uuid[])`;
  }

  /** The same tag added to many contacts at once (bulk tagging, imports). */
  async recordTagAddedToMany(db: Db, links: ReadonlyArray<{ contactId: string; tagId: string }>): Promise<void> {
    const byContact = new Map<string, string[]>();
    for (const l of links) byContact.set(l.contactId, [...(byContact.get(l.contactId) ?? []), l.tagId]);
    if (!byContact.size) return;
    if (!(await this.listens(db, 'TAG_ADDED')) && !(await this.hasStopTags(db, links.map((l) => l.tagId)))) return;
    for (const [contactId, tagIds] of byContact) await this.recordTagsAdded(db, contactId, tagIds);
  }

  /** Contacts whose consent became opted in, from any source. */
  async recordOptIns(db: Db, contactIds: readonly string[]): Promise<void> {
    await this.record(db, 'OPTED_IN', contactIds);
  }

  /** Contacts created by an import or by the public API (not existing contacts). */
  async recordCreated(db: Db, via: 'IMPORTED' | 'API_CREATED', contactIds: readonly string[]): Promise<void> {
    await this.record(db, via, contactIds);
  }

  /** A real click on a tracked link: starting events of campaigns, and leaving a drip on its own links. */
  async recordClick(db: Db, contactId: string, link: { campaignId: string | null; dripId: string | null }): Promise<void> {
    if (link.dripId) await this.leaving.onEvent(contactId, { kind: 'CLICKED', dripId: link.dripId }, db);
    if (!link.campaignId || !(await this.listens(db, 'LINK_CLICKED'))) return;
    await db.dripEvent.create({ data: { kind: 'LINK_CLICKED', contactId, campaignId: link.campaignId } });
  }

  /**
   * Turns waiting events into enrolments (run by the drip tick before due steps). Each contact joins a
   * listening active drip once: not while already in it, and again later only when the drip allows
   * it. Opted-out and blocked contacts do not join. Events are deleted once handled.
   */
  async consume(): Promise<number> {
    const enrolled = await this.prisma.$transaction(
      async (tx) => {
        const taken = await tx.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM drip_events ORDER BY id LIMIT ${CONSUME_BATCH} FOR UPDATE SKIP LOCKED`;
        if (!taken.length) return 0;
        const ids = taken.map((t) => t.id);
        const enrolled = await tx.$executeRaw`
          INSERT INTO drip_enrolments (id, drip_id, contact_id, status, joined_via, current_position, next_due_at, joined_at)
          SELECT gen_random_uuid(), x.drip_id, x.contact_id, 'ACTIVE', x.kind::text::"DripJoinVia", 1, now() + make_interval(mins => x.wait_minutes), now()
            FROM (
              SELECT DISTINCT ON (d.id, e.contact_id) d.id AS drip_id, e.contact_id, e.kind, s.wait_minutes, d.allow_rejoin
                FROM drip_events e
                JOIN drip_triggers t ON t.kind = e.kind
                                    AND (e.kind <> 'TAG_ADDED' OR t.tag_id = e.tag_id)
                                    AND (e.kind <> 'LINK_CLICKED' OR t.campaign_id IS NULL OR t.campaign_id = e.campaign_id)
                JOIN drips d ON d.id = t.drip_id AND d.status = 'ACTIVE'
                JOIN drip_steps s ON s.drip_id = d.id AND s.deleted_at IS NULL AND s.position = 1
                JOIN contacts c ON c.id = e.contact_id AND c.consent_status <> 'OPTED_OUT' AND c.blocked_at IS NULL
               WHERE e.id = ANY(${ids}::bigint[])
               ORDER BY d.id, e.contact_id, e.id
            ) x
           WHERE NOT EXISTS (
             SELECT 1 FROM drip_enrolments p
              WHERE p.drip_id = x.drip_id AND p.contact_id = x.contact_id AND (p.status = 'ACTIVE' OR NOT x.allow_rejoin)
           )
          ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`DELETE FROM drip_events WHERE id = ANY(${ids}::bigint[])`;
        return enrolled;
      },
      { timeout: 60_000 },
    );
    if (enrolled) this.metrics.dripEnrolmentsTotal.inc({ via: 'event' }, enrolled);
    return enrolled;
  }

  private async record(db: Db, kind: 'OPTED_IN' | 'IMPORTED' | 'API_CREATED', contactIds: readonly string[]): Promise<void> {
    if (!contactIds.length || !(await this.listens(db, kind))) return;
    await db.dripEvent.createMany({ data: contactIds.map((contactId) => ({ kind, contactId })) });
  }

  /** True when an active drip starts on this kind of event. */
  private async listens(db: Db, kind: DripTriggerKind): Promise<boolean> {
    const [row] = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM drip_triggers t JOIN drips d ON d.id = t.drip_id AND d.status = 'ACTIVE' WHERE t.kind = ${kind}::"DripTriggerKind") AS found`;
    return Boolean(row?.found);
  }

  private async hasStopTags(db: Db, tagIds: readonly string[]): Promise<boolean> {
    const [row] = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM drips WHERE status IN ('ACTIVE', 'PAUSED') AND stop_tag_ids && ${[...new Set(tagIds)]}::uuid[]) AS found`;
    return Boolean(row?.found);
  }
}
