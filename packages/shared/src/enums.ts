// Shared enums mirroring specs/001-whatsapp-bulk-messaging/data-model.md (T018).
// Declared as const objects + union types so they work in both Node (ESM) and the browser.

export const Role = { ADMIN: 'ADMIN', MANAGER: 'MANAGER', AGENT: 'AGENT' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = { INVITED: 'INVITED', ACTIVE: 'ACTIVE', DEACTIVATED: 'DEACTIVATED' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ConsentStatus = { OPTED_IN: 'OPTED_IN', OPTED_OUT: 'OPTED_OUT', UNKNOWN: 'UNKNOWN' } as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];

export const ConsentSource = {
  IMPORT: 'IMPORT',
  UPLOAD_CONFIRMATION: 'UPLOAD_CONFIRMATION',
  API: 'API',
  KEYWORD: 'KEYWORD',
  MANUAL: 'MANUAL',
  // Feature 004: a customer asked the AI agent, in their own words, not to be messaged (FR-027).
  AI_AGENT: 'AI_AGENT',
  // Feature 006: a store checkout consent the admin confirmed names WhatsApp (FR-027).
  STORE: 'STORE',
  // Feature 007: a lead form answer that ticked the WhatsApp consent box (FR-034).
  LEAD_FORM: 'LEAD_FORM',
  // Feature 008: a WhatsApp Form opt-in field the customer ticked (FR-035).
  FORM: 'FORM',
} as const;
export type ConsentSource = (typeof ConsentSource)[keyof typeof ConsentSource];

export const TemplateCategory = {
  MARKETING: 'MARKETING',
  UTILITY: 'UTILITY',
  AUTHENTICATION: 'AUTHENTICATION',
} as const;
export type TemplateCategory = (typeof TemplateCategory)[keyof typeof TemplateCategory];

export const TemplateStatus = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  DELETED: 'DELETED',
} as const;
export type TemplateStatus = (typeof TemplateStatus)[keyof typeof TemplateStatus];

export const CampaignState = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type CampaignState = (typeof CampaignState)[keyof typeof CampaignState];

export const AudienceType = {
  FILTER: 'FILTER',
  ALL_OPTED_IN: 'ALL_OPTED_IN',
  UPLOAD: 'UPLOAD',
  RETARGET: 'RETARGET',
} as const;
export type AudienceType = (typeof AudienceType)[keyof typeof AudienceType];

export const MessageStatus = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const SkipReason = {
  OPTED_OUT: 'OPTED_OUT',
  NO_OPT_IN: 'NO_OPT_IN',
  INVALID_NUMBER: 'INVALID_NUMBER',
  DUPLICATE: 'DUPLICATE',
  MISSING_VARIABLE: 'MISSING_VARIABLE',
} as const;
export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export const NotificationType = {
  CAMPAIGN_COMPLETED: 'CAMPAIGN_COMPLETED',
  CAMPAIGN_AUTO_PAUSED: 'CAMPAIGN_AUTO_PAUSED',
  QUALITY_DROPPED: 'QUALITY_DROPPED',
  CREDENTIALS_FAILED: 'CREDENTIALS_FAILED',
  // Feature 002 live chat
  INBOX_REQUESTING: 'INBOX_REQUESTING',
  INBOX_TRANSFERRED: 'INBOX_TRANSFERRED',
  INBOX_MENTION: 'INBOX_MENTION',
  // Feature 004 AI agent
  AI_USAGE: 'AI_USAGE',
  AI_FAILING: 'AI_FAILING',
  // Feature 005 campaign growth
  DRIP_PAUSED: 'DRIP_PAUSED',
  // Feature 006 integrations
  WEBHOOK_ENDPOINT_FAILING: 'WEBHOOK_ENDPOINT_FAILING',
  STORE_CONNECTION_ERROR: 'STORE_CONNECTION_ERROR',
  API_CAMPAIGN_PAUSED: 'API_CAMPAIGN_PAUSED',
  COD_CANCELLED: 'COD_CANCELLED',
  // Feature 007 ads
  ADS_CONNECTION_ERROR: 'ADS_CONNECTION_ERROR',
  AD_REJECTED: 'AD_REJECTED',
  AD_NOT_DELIVERING: 'AD_NOT_DELIVERING',
  ADS_SPEND_CAP_REACHED: 'ADS_SPEND_CAP_REACHED',
  // Feature 008 commerce and payments
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_PAID_LATE: 'PAYMENT_PAID_LATE',
  PAYMENTS_CONNECTION_ERROR: 'PAYMENTS_CONNECTION_ERROR',
  CATALOG_SYNC_FAILED: 'CATALOG_SYNC_FAILED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** Live chat states (feature 002, data-model §4). UI labels: Open, Waiting for agent, Taken. */
export const ConversationState = { ACTIVE: 'ACTIVE', REQUESTING: 'REQUESTING', INTERVENED: 'INTERVENED' } as const;
export type ConversationState = (typeof ConversationState)[keyof typeof ConversationState];
