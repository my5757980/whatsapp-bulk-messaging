// Live chat response shapes (specs/002-team-inbox/contracts/inbox-api.openapi.yaml).

export type ConversationState = 'ACTIVE' | 'REQUESTING' | 'INTERVENED';

export interface MemberRef {
  id: string;
  name: string;
}

export interface ConversationSummary {
  id: string;
  contactId: string | null;
  contactName: string | null;
  /** Masked to the last 4 digits for agents. */
  phone: string | null;
  numberId: string;
  numberLabel: string;
  state: ConversationState;
  intervenedBy: MemberRef | null;
  inHistory: boolean;
  windowEndsAt: string | null;
  lastActivityAt: string;
  lastMessagePreview: string | null;
  unread: number;
  blocked: boolean;
  tags: string[];
}

export interface ConversationList {
  items: ConversationSummary[];
  nextCursor: string | null;
  counts: { ACTIVE: number; REQUESTING: number; INTERVENED: number; HISTORY: number };
}

export interface ContactProfile {
  contactId: string | null;
  name: string | null;
  phone: string | null;
  leadSource: string | null;
  firstMessageTag: { id: string; name: string } | null;
  consentStatus: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
  consentSource: string | null;
  consentAt: string | null;
  attributes: Record<string, unknown>;
  tags: Array<{ id: string; name: string }>;
  blocked: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  profile: ContactProfile;
  lastActiveAt: string | null;
  templateMessageCount: number;
  sessionMessageCount: number;
  unresolvedRequests: number;
  recentCampaigns: Array<{ campaignId: string; name: string; sentAt: string | null; status: string }>;
  canReply: boolean;
}

export type ChatContentType =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'STICKER'
  | 'LOCATION'
  | 'CONTACTS'
  | 'BUTTON_REPLY'
  | 'LIST_REPLY'
  | 'FORM_REPLY'
  | 'REACTION'
  | 'TEMPLATE'
  | 'UNSUPPORTED';

export type ChatItemStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface ChatItem {
  id: string;
  kind: 'INBOUND' | 'SESSION_OUT' | 'MESSAGE_REF' | 'NOTE';
  origin: 'CUSTOMER' | 'MEMBER' | 'AUTOMATIC' | 'CAMPAIGN' | 'API';
  contentType: ChatContentType;
  text: string | null;
  payload: Record<string, unknown>;
  media: { id?: string; mimeType?: string; sizeBytes?: number; fileName: string | null; state: 'PENDING' | 'READY' | 'FAILED' } | null;
  status: ChatItemStatus | null;
  failureReason: string | null;
  sentBy: MemberRef | null;
  template: { name: string; language: string; renderedText: string } | null;
  campaign: { id: string; name: string } | null;
  occurredAt: string;
}

export interface ChatItemPage {
  items: ChatItem[];
  nextBefore: string | null;
}

/** Our own UI wording (spec terms in comments, constitution Principle II). */
export const STATE_LABEL: Record<ConversationState, string> = {
  ACTIVE: 'Open', // Active
  REQUESTING: 'Waiting for agent', // Requesting
  INTERVENED: 'Taken', // Intervened
};
