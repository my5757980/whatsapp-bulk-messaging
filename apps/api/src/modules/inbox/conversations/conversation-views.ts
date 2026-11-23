import type { Prisma } from '../../../generated/prisma/client.js';
import { renderBodyPreview } from '../../campaigns/variable-resolver.js';
import type { ChatFacts } from './visibility.js';
import { windowEndsAt, isLive } from './window.js';

// Response shapes of specs/002-team-inbox/contracts/inbox-api.openapi.yaml (ConversationSummary,
// ChatItem) and the Prisma includes they are built from. Phones are masked for agents by the
// global PhoneMaskInterceptor (field `phone`), never here.

export const SUMMARY_INCLUDE = {
  contact: {
    select: {
      id: true,
      name: true,
      phoneE164: true,
      blockedAt: true,
      attributes: true,
      tags: { select: { tagId: true, tag: { select: { name: true } } } },
    },
  },
  number: { select: { id: true, label: true, phoneNumberId: true, connectionStatus: true, sendingEnabled: true, accessTokenEnc: true } },
  intervenedBy: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude;

export type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

export interface MemberRef {
  id: string;
  name: string;
}

export interface ConversationSummaryDto {
  id: string;
  contactId: string | null;
  contactName: string | null;
  phone: string | null;
  numberId: string;
  numberLabel: string;
  state: ConversationRow['state'];
  intervenedBy: MemberRef | null;
  inHistory: boolean;
  windowEndsAt: string | null;
  lastActivityAt: string;
  lastMessagePreview: string | null;
  unread: number;
  blocked: boolean;
  tags: string[];
}

/** Visibility facts of a loaded chat (research R7). */
export function factsOf(row: ConversationRow): ChatFacts {
  return {
    state: row.state,
    intervenedById: row.intervenedById,
    blocked: row.contact?.blockedAt != null,
    contactTagIds: row.contact?.tags.map((t) => t.tagId) ?? [],
    contactAttributes: (row.contact?.attributes ?? {}) as Record<string, unknown>,
  };
}

export function toSummaryDto(row: ConversationRow, unread: number, now: Date = new Date()): ConversationSummaryDto {
  const ends = windowEndsAt(row.lastCustomerMessageAt);
  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.contact?.name ?? null,
    phone: row.contact?.phoneE164 ?? null,
    numberId: row.numberId,
    numberLabel: row.number.label,
    state: row.state,
    intervenedBy: row.intervenedBy ? { id: row.intervenedBy.id, name: row.intervenedBy.name } : null,
    inHistory: !isLive(row.lastCustomerMessageAt, now),
    windowEndsAt: ends?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    unread: Math.min(99, unread),
    blocked: row.contact?.blockedAt != null,
    tags: (row.contact?.tags.map((t) => t.tag.name) ?? []).sort(),
  };
}

export const ITEM_INCLUDE = {
  mediaAsset: { select: { id: true, mimeType: true, sizeBytes: true } },
  sentBy: { select: { id: true, name: true } },
  message: {
    select: {
      status: true,
      failureReason: true,
      resolvedParams: true,
      sentBy: { select: { id: true, name: true } },
      template: { select: { name: true, language: true, components: true } },
      campaign: { select: { id: true, name: true } },
      // Feature 005 (FR-009): the first click on a tracked link of this message.
      trackedLinks: { select: { clicks: { select: { clickedAt: true }, orderBy: { clickedAt: 'asc' }, take: 1 } } },
    },
  },
} satisfies Prisma.ChatMessageInclude;

export type ChatItemRow = Prisma.ChatMessageGetPayload<{ include: typeof ITEM_INCLUDE }>;

type ItemStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface ChatItemDto {
  id: string;
  kind: ChatItemRow['kind'];
  origin: ChatItemRow['origin'];
  contentType: ChatItemRow['contentType'];
  text: string | null;
  payload: Record<string, unknown>;
  media: { id?: string; mimeType?: string; sizeBytes?: number; fileName: string | null; state: 'PENDING' | 'READY' | 'FAILED' } | null;
  status: ItemStatus | null;
  failureReason: string | null;
  sentBy: MemberRef | null;
  template: { name: string; language: string; renderedText: string } | null;
  campaign: { id: string; name: string } | null;
  /** When the contact first opened a tracked link of this template message (feature 005). */
  firstClickAt: string | null;
  occurredAt: string;
}

function firstClickOf(ref: ChatItemRow['message']): string | null {
  const times = (ref?.trackedLinks ?? []).flatMap((l) => l.clicks.map((c) => c.clickedAt.getTime()));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** The text of a template's BODY component. */
export function templateBodyText(components: unknown): string {
  const list = Array.isArray(components) ? (components as Array<{ type?: string; text?: string }>) : [];
  return list.find((c) => c.type === 'BODY')?.text ?? '';
}

/** Statuses of `messages` that are not chat ticks: waiting ones show as queued, dropped ones as failed. */
function refStatus(status: string): ItemStatus {
  switch (status) {
    case 'PENDING':
      return 'QUEUED';
    case 'SKIPPED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return status as ItemStatus;
  }
}

export function toItemDto(row: ChatItemRow): ChatItemDto {
  const ref = row.message;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const mediaState = row.mediaState ?? (row.mediaAsset ? 'READY' : null);
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    contentType: row.contentType,
    text: row.text,
    payload,
    media: mediaState
      ? {
          ...(row.mediaAsset ? { id: row.mediaAsset.id, mimeType: row.mediaAsset.mimeType, sizeBytes: row.mediaAsset.sizeBytes } : {}),
          ...(!row.mediaAsset && typeof payload.mimeType === 'string' ? { mimeType: payload.mimeType } : {}),
          fileName: typeof payload.fileName === 'string' ? payload.fileName : null,
          state: mediaState,
        }
      : null,
    status: row.kind === 'SESSION_OUT' ? ((row.status as ItemStatus | null) ?? null) : ref ? refStatus(ref.status) : null,
    failureReason: row.kind === 'SESSION_OUT' ? row.failureReason : (ref?.failureReason ?? null),
    sentBy: row.sentBy ?? ref?.sentBy ?? null,
    template: ref
      ? {
          name: ref.template.name,
          language: ref.template.language,
          renderedText: renderBodyPreview(templateBodyText(ref.template.components), (ref.resolvedParams ?? {}) as Record<string, string>),
        }
      : null,
    campaign: ref?.campaign ? { id: ref.campaign.id, name: ref.campaign.name } : null,
    firstClickAt: firstClickOf(ref),
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** Opaque keyset cursor over (timestamp, id). */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at: date, id };
  } catch {
    return null;
  }
}
