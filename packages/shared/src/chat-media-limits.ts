// Media limits for files sent in a live chat (feature 002 spec FR-015), shared by the API (enforced)
// and the web app (checked before uploading).

export type ChatMediaKind = 'image' | 'video' | 'audio' | 'document';

const MB = 1024 * 1024;

interface Limit {
  label: string;
  formats: string;
  maxBytes: number;
  types: readonly string[];
}

export const CHAT_MEDIA_LIMITS: Readonly<Record<ChatMediaKind, Limit>> = {
  image: { label: 'Images', formats: 'JPEG, PNG', maxBytes: 5 * MB, types: ['image/jpeg', 'image/png'] },
  video: { label: 'Videos', formats: 'MP4, 3GPP', maxBytes: 16 * MB, types: ['video/mp4', 'video/3gpp'] },
  audio: {
    label: 'Audio files',
    formats: 'AAC, MP3, MPEG-4 audio, AMR, OGG',
    maxBytes: 16 * MB,
    types: ['audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/amr', 'audio/ogg'],
  },
  document: {
    label: 'Documents',
    formats: 'PDF, Word, Excel, PowerPoint, text',
    maxBytes: 100 * MB,
    types: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
  },
};

export type ChatMediaCheck = { ok: true; kind: ChatMediaKind } | { ok: false; code: 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE'; message: string };

/** The media kind for a MIME type ("audio/ogg; codecs=opus" counts as audio/ogg), or null. */
export function chatMediaKind(mimeType: string): ChatMediaKind | null {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  for (const [kind, limit] of Object.entries(CHAT_MEDIA_LIMITS) as Array<[ChatMediaKind, Limit]>) {
    if (limit.types.includes(base)) return kind;
  }
  return null;
}

/** Checks a file before it is sent in a chat; the message names the type and its limit. */
export function checkChatMedia(mimeType: string, sizeBytes: number): ChatMediaCheck {
  const kind = chatMediaKind(mimeType);
  if (!kind) {
    const accepted = Object.values(CHAT_MEDIA_LIMITS)
      .map((l) => `${l.label.toLowerCase()} (${l.formats})`)
      .join(', ');
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', message: `This file type cannot be sent in a chat. Use ${accepted}.` };
  }
  const limit = CHAT_MEDIA_LIMITS[kind];
  if (sizeBytes > limit.maxBytes) {
    return { ok: false, code: 'FILE_TOO_LARGE', message: `${limit.label} can be at most ${limit.maxBytes / MB} MB` };
  }
  return { ok: true, kind };
}
