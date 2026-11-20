import { cutText, PREVIEW_MAX, type ChatContentType } from '../inbox-common.js';

// Turns one entry of a Meta `value.messages[]` webhook into a chat item
// (specs/002-team-inbox/contracts/meta-graph-inbox.md §1, data-model §3). Pure: no I/O.

export interface ParsedInbound {
  waMessageId: string;
  /** The customer's WhatsApp ID (digits, no "+"). */
  waId: string;
  profileName: string | null;
  occurredAt: Date;
  contentType: ChatContentType;
  text: string | null;
  payload: Record<string, unknown>;
  /** Media still to download from Meta (research R4). */
  media: { metaMediaId: string; mimeType: string | null } | null;
  replyToWaId: string | null;
}

type Content = Pick<ParsedInbound, 'contentType' | 'text' | 'payload' | 'media'>;
type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
/** Copies only the fields that have a value. */
const compact = (fields: Json): Json => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));

const MEDIA_TYPES: Record<string, ChatContentType> = {
  image: 'IMAGE',
  video: 'VIDEO',
  sticker: 'STICKER',
  document: 'DOCUMENT',
  audio: 'AUDIO',
};

/** Returns null for entries without an ID, sender or type (logged and skipped by the caller). */
export function parseInboundMessage(message: unknown, contacts: unknown = []): ParsedInbound | null {
  const m = obj(message);
  const waMessageId = str(m?.id);
  const waId = str(m?.from);
  const type = str(m?.type);
  if (!m || !waMessageId || !waId || !type) return null;

  const content = parseContent(type, m);
  if (!content) return null;
  const seconds = num(m.timestamp);
  return {
    waMessageId,
    waId,
    profileName: profileNameFor(contacts, waId),
    occurredAt: seconds !== null && seconds > 0 ? new Date(seconds * 1000) : new Date(),
    ...content,
    replyToWaId: str(obj(m.context)?.id),
  };
}

function profileNameFor(contacts: unknown, waId: string): string | null {
  const list = Array.isArray(contacts) ? contacts.map(obj).filter((c): c is Json => c !== undefined) : [];
  const match = list.find((c) => c.wa_id === waId) ?? (list.length === 1 ? list[0] : undefined);
  return str(obj(match?.profile)?.name);
}

function parseContent(type: string, m: Json): Content | null {
  const mediaType = MEDIA_TYPES[type];
  if (mediaType) return parseMedia(type, mediaType, obj(m[type]));

  switch (type) {
    case 'text': {
      const body = obj(m.text)?.body;
      return { contentType: 'TEXT', text: typeof body === 'string' ? body : '', payload: {}, media: null };
    }
    case 'location': {
      const location = obj(m.location);
      const latitude = num(location?.latitude);
      const longitude = num(location?.longitude);
      if (latitude === null || longitude === null) return unsupported(type, m);
      return {
        contentType: 'LOCATION',
        text: null,
        payload: compact({ latitude, longitude, name: str(location?.name), address: str(location?.address) }),
        media: null,
      };
    }
    case 'contacts': {
      const cards = (Array.isArray(m.contacts) ? m.contacts : []).map(obj).filter((c): c is Json => c !== undefined);
      return { contentType: 'CONTACTS', text: null, payload: { contacts: cards.map(contactCard) }, media: null };
    }
    case 'interactive':
      return parseInteractive(m);
    case 'button': {
      const button = obj(m.button);
      const title = str(button?.text) ?? '';
      return { contentType: 'BUTTON_REPLY', text: title, payload: compact({ payload: str(button?.payload), title }), media: null };
    }
    case 'reaction': {
      const reaction = obj(m.reaction);
      const targetWaId = str(reaction?.message_id);
      if (!targetWaId) return unsupported(type, m);
      // An empty emoji means the customer removed the reaction.
      return { contentType: 'REACTION', text: null, payload: { targetWaId, emoji: typeof reaction?.emoji === 'string' ? reaction.emoji : '' }, media: null };
    }
    default:
      return unsupported(type, m);
  }
}

function parseMedia(type: string, contentType: ChatContentType, media: Json | undefined): Content | null {
  const metaMediaId = str(media?.id);
  if (!metaMediaId) return null;
  const mimeType = str(media?.mime_type);
  const caption = type === 'image' || type === 'video' || type === 'document' ? str(media?.caption) : null;
  const payload =
    type === 'document'
      ? compact({ fileName: str(media?.filename), mimeType })
      : type === 'audio'
        ? compact({ voice: media?.voice === true, mimeType })
        : compact({ mimeType });
  return { contentType, text: caption, payload, media: { metaMediaId, mimeType } };
}

function contactCard(card: Json): Json {
  const name = obj(card.name);
  const fullName = str(name?.formatted_name) ?? ([str(name?.first_name), str(name?.last_name)].filter(Boolean).join(' ') || 'Contact');
  const phones = (Array.isArray(card.phones) ? card.phones : []).map((p) => str(obj(p)?.phone) ?? str(obj(p)?.wa_id)).filter((p): p is string => p !== null);
  const emails = (Array.isArray(card.emails) ? card.emails : []).map((e) => str(obj(e)?.email)).filter((e): e is string => e !== null);
  return compact({ name: fullName, phones, emails: emails.length ? emails : null });
}

function parseInteractive(m: Json): Content {
  const interactive = obj(m.interactive);
  const kind = str(interactive?.type);
  if (kind === 'button_reply' || kind === 'list_reply') {
    const reply = obj(interactive?.[kind]);
    const title = str(reply?.title) ?? '';
    return {
      contentType: kind === 'button_reply' ? 'BUTTON_REPLY' : 'LIST_REPLY',
      text: title,
      payload: compact({ id: str(reply?.id), title, description: str(reply?.description) }),
      media: null,
    };
  }
  if (kind === 'nfm_reply') {
    const form = obj(interactive?.nfm_reply);
    const raw = form?.response_json;
    let response: unknown = raw ?? null;
    if (typeof raw === 'string') {
      try {
        response = JSON.parse(raw);
      } catch {
        response = raw;
      }
    }
    return { contentType: 'FORM_REPLY', text: null, payload: compact({ response, name: str(form?.name) }), media: null };
  }
  return unsupported(`interactive:${kind ?? 'unknown'}`, m);
}

function unsupported(rawType: string, m: Json): Content {
  const error = obj(Array.isArray(m.errors) ? m.errors[0] : undefined);
  return {
    contentType: 'UNSUPPORTED',
    text: null,
    payload: compact({ rawType, errorCode: num(error?.code), errorTitle: str(error?.title) }),
    media: null,
  };
}

/** A one-line description for chat lists, at most 120 characters. */
export function previewOf(item: { contentType: ChatContentType; text: string | null; payload: Record<string, unknown> }): string {
  const clean = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
  const withCaption = (label: string) => (clean(item.text) ? `${label}: ${clean(item.text)}` : label);
  const p = item.payload;
  let line: string;
  switch (item.contentType) {
    case 'TEXT':
    case 'TEMPLATE':
    case 'BUTTONS':
    case 'LIST':
      line = clean(item.text);
      break;
    case 'IMAGE':
      line = withCaption('📷 Photo');
      break;
    case 'VIDEO':
      line = withCaption('🎥 Video');
      break;
    case 'STICKER':
      line = 'Sticker';
      break;
    case 'AUDIO':
      line = p.voice === true ? '🎤 Voice message' : '🎵 Audio';
      break;
    case 'DOCUMENT':
      line = `📄 ${str(p.fileName) ?? 'Document'}`;
      break;
    case 'LOCATION':
      line = `📍 ${str(p.name) ?? 'Location'}`;
      break;
    case 'CONTACTS': {
      const first = Array.isArray(p.contacts) ? str(obj(p.contacts[0])?.name) : null;
      line = `👤 ${first ?? 'Contact card'}`;
      break;
    }
    case 'BUTTON_REPLY':
    case 'LIST_REPLY':
      line = clean(str(p.title) ?? item.text);
      break;
    case 'FORM_REPLY':
      line = '📝 Form reply';
      break;
    case 'REACTION':
      line = str(p.emoji) ? `Reacted ${String(p.emoji)}` : 'Removed a reaction';
      break;
    default:
      line = 'Unsupported message';
  }
  return cutText(line, PREVIEW_MAX);
}
