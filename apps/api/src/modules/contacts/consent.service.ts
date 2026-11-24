import { Injectable } from '@nestjs/common';
import type { ConsentSource, ConsentStatus } from '@wbm/shared';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { DripEvents } from '../growth/drips/drip-events.js';
import { DripLeaving } from '../growth/drips/drip-leaving.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';

// Consent changes (FR-012-FR-014, T092). Every status change and its consent_events row are
// written in one transaction, and an opt-out can only be undone by the contact (keyword) or an
// admin (manual) - never by a bulk upload, an import or another system's API call (Principle I).

export type ConsentChange = 'changed' | 'unchanged' | 'blocked';

/** Sources that cannot undo an opt-out: bulk lists and other company systems. */
const BULK_SOURCES: ReadonlySet<ConsentSource> = new Set(['IMPORT', 'UPLOAD_CONFIRMATION', 'API']);

export interface UploadContact {
  phoneE164: string;
  countryCode: string;
  name: string | null;
}

export interface BulkOptInResult {
  created: number;
  updated: number;
  optedOut: number;
}

@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drips: DripLeaving,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
  ) {}

  async setStatus(
    contactId: string,
    status: ConsentStatus,
    source: ConsentSource,
    opts: { note?: string | null; actorUserId?: string | null } = {},
    /** The caller's transaction (004: an AI opt-out is recorded with the AI conversation's end). */
    within?: Prisma.TransactionClient,
  ): Promise<ConsentChange> {
    const run = (work: (tx: Prisma.TransactionClient) => Promise<ConsentChange>) => (within ? work(within) : this.prisma.$transaction(work));
    return run(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ consent_status: ConsentStatus }>>`
        SELECT consent_status FROM contacts WHERE id = ${contactId}::uuid FOR UPDATE`;
      const current = rows[0]?.consent_status;
      if (!current) return 'unchanged';
      if (current === status) return 'unchanged';
      if (current === 'OPTED_OUT' && BULK_SOURCES.has(source)) return 'blocked';
      const now = new Date();
      await tx.contact.update({
        where: { id: contactId },
        data: { consentStatus: status, consentSource: source, consentSourceNote: opts.note ?? null, consentAt: now },
      });
      await tx.consentEvent.create({
        data: { contactId, status, source, note: opts.note ?? null, actorUserId: opts.actorUserId ?? null, createdAt: now },
      });
      // An opt-out ends every drip of the contact at once (feature 005, FR-028).
      if (status === 'OPTED_OUT') await this.drips.onEvent(contactId, { kind: 'OPTED_OUT' }, tx);
      // An opt-in can start drips (feature 005, FR-024).
      if (status === 'OPTED_IN') await this.dripEvents.recordOptIns(tx, [contactId]);
      // Outbound webhooks (feature 006, FR-002).
      if (status === 'OPTED_IN') await this.platformEvents.optedIn(tx, contactId, source, opts.note ?? null);
      if (status === 'OPTED_OUT') await this.platformEvents.optedOut(tx, contactId, source);
      return 'changed';
    });
  }

  /**
   * Opt-ins from a contacts import (T124), inside the caller's transaction: contacts the import
   * just created OPTED_IN get their consent event; existing UNKNOWN contacts become OPTED_IN.
   * Opted-out contacts are never changed by an import.
   */
  async recordImportOptIns(
    tx: Prisma.TransactionClient,
    created: Array<{ contactId: string; note: string }>,
    existing: Array<{ contactId: string; note: string }>,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    const confirmed = existing.length
      ? await tx.$queryRaw<Array<{ id: string; note: string }>>`
          UPDATE contacts c
             SET consent_status = 'OPTED_IN'::"ConsentStatus", consent_source = 'IMPORT'::"ConsentSource",
                 consent_source_note = v.note, consent_at = ${now}, updated_at = ${now}
            FROM (VALUES ${Prisma.join(existing.map((e) => Prisma.sql`(${e.contactId}::uuid, ${e.note})`))}) AS v(id, note)
           WHERE c.id = v.id AND c.consent_status = 'UNKNOWN'::"ConsentStatus"
       RETURNING c.id, v.note`
      : [];
    const events = [...created.map((c) => ({ id: c.contactId, note: c.note })), ...confirmed].map(({ id, note }) => ({
      contactId: id,
      status: 'OPTED_IN' as const,
      source: 'IMPORT' as const,
      note,
      actorUserId,
      createdAt: now,
    }));
    if (events.length) await tx.consentEvent.createMany({ data: events });
    await this.dripEvents.recordOptIns(tx, events.map((e) => e.contactId));
    await this.platformEvents.optedInMany(tx, events.map((e) => ({ contactId: e.contactId, note: e.note })), 'IMPORT');
  }

  /**
   * Upload confirmation for a batch of rows (R13): new contacts are created OPTED_IN, existing
   * UNKNOWN contacts become OPTED_IN, opted-out contacts stay opted out. Names fill empty names only.
   */
  async bulkConfirmOptIn(rows: UploadContact[], note: string, actorUserId: string): Promise<BulkOptInResult> {
    if (!rows.length) return { created: 0, updated: 0, optedOut: 0 };
    return this.prisma.$transaction(
      async (tx) => {
        const phones = rows.map((r) => r.phoneE164);
        const existing = await tx.contact.findMany({
          where: { phoneE164: { in: phones } },
          select: { id: true, phoneE164: true, consentStatus: true, name: true },
        });
        const byPhone = new Map(existing.map((c) => [c.phoneE164, c]));
        const now = new Date();

        const fresh = rows.filter((r) => !byPhone.has(r.phoneE164));
        const created = fresh.length
          ? await tx.contact.createManyAndReturn({
              data: fresh.map((r) => ({
                phoneE164: r.phoneE164,
                countryCode: r.countryCode,
                name: r.name,
                consentStatus: 'OPTED_IN' as const,
                consentSource: 'UPLOAD_CONFIRMATION' as const,
                consentSourceNote: note,
                consentAt: now,
                leadSource: 'Campaign upload',
              })),
              skipDuplicates: true,
              select: { id: true },
            })
          : [];

        const toConfirm = existing.filter((c) => c.consentStatus === 'UNKNOWN').map((c) => c.id);
        const confirmed = toConfirm.length
          ? await tx.$queryRaw<Array<{ id: string }>>`
              UPDATE contacts
                 SET consent_status = 'OPTED_IN'::"ConsentStatus", consent_source = 'UPLOAD_CONFIRMATION'::"ConsentSource",
                     consent_source_note = ${note}, consent_at = ${now}, updated_at = ${now}
               WHERE id IN (${Prisma.join(toConfirm.map((id) => Prisma.sql`${id}::uuid`))})
                 AND consent_status = 'UNKNOWN'::"ConsentStatus"
           RETURNING id`
          : [];

        const events = [...created, ...confirmed].map(({ id }) => ({
          contactId: id,
          status: 'OPTED_IN' as const,
          source: 'UPLOAD_CONFIRMATION' as const,
          note,
          actorUserId,
          createdAt: now,
        }));
        if (events.length) await tx.consentEvent.createMany({ data: events });
        await this.dripEvents.recordOptIns(tx, events.map((e) => e.contactId));
        await this.platformEvents.optedInMany(tx, events.map((e) => ({ contactId: e.contactId, note })), 'UPLOAD_CONFIRMATION');

        const named = rows.filter((r) => r.name && byPhone.has(r.phoneE164) && !byPhone.get(r.phoneE164)?.name);
        for (const row of named) {
          await tx.contact.updateMany({ where: { phoneE164: row.phoneE164, name: null }, data: { name: row.name } });
        }

        const optedOut = existing.filter((c) => c.consentStatus === 'OPTED_OUT').length;
        return { created: created.length, updated: existing.length - optedOut, optedOut };
      },
      // Runs inside the audience upload job: wait for a pooled connection rather than fail.
      { maxWait: 30_000, timeout: 60_000 },
    );
  }
}
