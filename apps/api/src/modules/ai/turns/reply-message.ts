import { AI_LIMITS, checkChatMedia, type AgentReply } from '@wbm/shared';

// The 002 chat items an AI reply becomes (004 T067, FR-028), using the 003 interactive content
// types so the session sender builds the WhatsApp message. Pure, so it is unit-tested (T064).

/** A shared file from the media library that the reply names. */
export interface ReplyMedia {
  id: string;
  mimeType: string;
  sizeBytes: number;
  displayName: string | null;
}

export type ReplyContentType = 'TEXT' | 'BUTTONS' | 'LIST' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

export interface ReplyItem {
  contentType: ReplyContentType;
  text: string | null;
  mediaAssetId: string | null;
  payload: Record<string, unknown>;
}

export interface ReplyItemContext {
  aiConversationId: string;
  /** The file reply.mediaId names, when it is still in the library; null otherwise. */
  media: ReplyMedia | null;
  allowButtons: boolean;
  allowLists: boolean;
}

/** WhatsApp limit for captions and interactive message bodies. */
const BODY_LIMIT = AI_LIMITS.mediaCaption;

/** At most `limit` characters (code points), with an ellipsis when cut. */
function fit(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

/** Reply ids of the agent's buttons and list rows; a tap reaches the agent as the row's title. */
export function replyOptionId(aiConversationId: string, n: number): string {
  return `ai:${aiConversationId}:${n}`;
}

/**
 * The chat items for an AI reply, in sending order: a shared file with the message as its caption
 * (audio cannot carry one, so the message goes first as text); else up to 3 reply buttons; else a
 * list of up to 10 options; else plain text. Buttons and lists the agent may not send fall back to text.
 */
export function replyItems(message: string, reply: Pick<AgentReply, 'buttons' | 'list' | 'mediaId'>, ctx: ReplyItemContext): ReplyItem[] {
  const asset = ctx.media;
  const check = asset ? checkChatMedia(asset.mimeType, asset.sizeBytes) : null;
  if (asset && check?.ok) {
    const contentType: ReplyContentType = check.kind === 'image' ? 'IMAGE' : check.kind === 'video' ? 'VIDEO' : check.kind === 'audio' ? 'AUDIO' : 'DOCUMENT';
    const payload: Record<string, unknown> = {
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      ...(contentType === 'DOCUMENT' ? { fileName: asset.displayName ?? 'document' } : {}),
    };
    if (contentType === 'AUDIO') {
      const audio: ReplyItem = { contentType, text: null, mediaAssetId: asset.id, payload };
      return message ? [{ contentType: 'TEXT', text: message, mediaAssetId: null, payload: {} }, audio] : [audio];
    }
    return [{ contentType, text: message ? fit(message, BODY_LIMIT) : null, mediaAssetId: asset.id, payload }];
  }

  if (ctx.allowButtons && reply.buttons?.length && message) {
    return [
      {
        contentType: 'BUTTONS',
        text: fit(message, BODY_LIMIT),
        mediaAssetId: null,
        payload: { header: null, footer: null, buttons: reply.buttons.map((title, i) => ({ id: replyOptionId(ctx.aiConversationId, i + 1), title })) },
      },
    ];
  }

  if (ctx.allowLists && reply.list?.rows.length && message) {
    return [
      {
        contentType: 'LIST',
        text: fit(message, BODY_LIMIT),
        mediaAssetId: null,
        payload: {
          header: null,
          footer: null,
          buttonLabel: reply.list.button,
          sections: [
            {
              title: null,
              rows: reply.list.rows.map((row, i) => ({ id: replyOptionId(ctx.aiConversationId, i + 1), title: row.title, description: row.description })),
            },
          ],
        },
      },
    ];
  }

  return [{ contentType: 'TEXT', text: message, mediaAssetId: null, payload: {} }];
}
