import { Injectable } from '@nestjs/common';
import { leavingReason, type DripLeavingEvent, type DripLeftReasonCode } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Leaving rules (feature 005, FR-028). Called inside the transaction of the event that triggers them
 * (a reply, an opt-out, a block, a deletion, a stop tag, a click) so no step can be sent after it:
 * the enrolment ends, and its step messages that are not sent yet are cancelled.
 */
@Injectable()
export class DripLeaving {
  constructor(private readonly prisma: PrismaService) {}

  /** Ends every active enrolment of the contact whose drip has this leaving rule. Returns how many ended. */
  async onEvent(contactId: string, event: DripLeavingEvent, db: Db = this.prisma): Promise<number> {
    const active = await db.$queryRaw<
      Array<{ id: string; drip_id: string; number_id: string; leave_on_reply: boolean; leave_on_click: boolean; stop_tag_ids: string[] | null }>
    >`
      SELECT e.id, d.id AS drip_id, d.number_id, d.leave_on_reply, d.leave_on_click, d.stop_tag_ids
        FROM drip_enrolments e JOIN drips d ON d.id = e.drip_id
       WHERE e.contact_id = ${contactId}::uuid AND e.status = 'ACTIVE'`;
    let left = 0;
    for (const row of active) {
      const reason = leavingReason(event, {
        id: row.drip_id,
        numberId: row.number_id,
        leaveOnReply: row.leave_on_reply,
        leaveOnClick: row.leave_on_click,
        stopTagIds: row.stop_tag_ids ?? [],
      });
      if (reason && (await this.leaveEnrolment(row.id, reason, db))) left += 1;
    }
    return left;
  }

  /** Ends one active enrolment and cancels its step messages that are not sent yet. */
  async leaveEnrolment(enrolmentId: string, reason: DripLeftReasonCode, db: Db = this.prisma): Promise<boolean> {
    const ended = await db.$executeRaw`
      UPDATE drip_enrolments
         SET status = 'LEFT', left_reason = ${reason}::"DripLeftReason", ended_at = now(), next_due_at = NULL
       WHERE id = ${enrolmentId}::uuid AND status = 'ACTIVE'`;
    if (!ended) return false;
    await db.$executeRaw`
      UPDATE messages SET status = 'CANCELLED', updated_at = now()
       WHERE drip_enrolment_id = ${enrolmentId}::uuid AND status IN ('PENDING', 'QUEUED')`;
    return true;
  }

  /** A drip message failed because the number is not on WhatsApp (FR-031): the contact leaves that drip. */
  async onInvalidNumber(messageId: string, db: Db = this.prisma): Promise<void> {
    const message = await db.message.findUnique({ where: { id: messageId }, select: { dripEnrolmentId: true } });
    if (message?.dripEnrolmentId) await this.leaveEnrolment(message.dripEnrolmentId, 'INVALID_NUMBER', db);
  }

  /** Archiving a drip ends every active enrolment with ARCHIVED. */
  async archiveAll(dripId: string, db: Db = this.prisma): Promise<number> {
    const ended = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE drip_enrolments
         SET status = 'LEFT', left_reason = 'ARCHIVED', ended_at = now(), next_due_at = NULL
       WHERE drip_id = ${dripId}::uuid AND status = 'ACTIVE'
      RETURNING id`;
    if (ended.length) {
      await db.$executeRaw`
        UPDATE messages SET status = 'CANCELLED', updated_at = now()
         WHERE drip_enrolment_id = ANY(${ended.map((e) => e.id)}::uuid[]) AND status IN ('PENDING', 'QUEUED')`;
    }
    return ended.length;
  }
}
