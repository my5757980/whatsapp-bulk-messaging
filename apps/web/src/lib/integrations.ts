import type { ApiKeyScope, EventType } from '@wbm/shared';

// Integrations types, query keys and labels (feature 006, T017; contracts/integrations-api.openapi.yaml
// and contracts/public-api-v1.openapi.yaml). Event and scope labels come from @wbm/shared.

// ---------- Webhooks (US1) ----------

export type WebhookEndpointStatus = 'ACTIVE' | 'PAUSED' | 'FAILING';
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
export type DeliveryError = 'TIMEOUT' | 'BLOCKED_ADDRESS' | 'NETWORK' | 'REDIRECT' | 'HTTP_4XX' | 'HTTP_5XX';

export interface WebhookEventTypeInfo {
  type: EventType;
  label: string;
  group: 'messages' | 'contacts' | 'links' | 'drips' | 'live_chat' | 'api_campaigns' | 'stores' | 'test';
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  eventTypes: EventType[];
  includeContent: boolean;
  status: WebhookEndpointStatus;
  secretHint?: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failingSince: string | null;
  waiting?: number;
  createdAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  /** Shown once. */
  secret: string;
}

export interface WebhookEndpointInput {
  name: string;
  url: string;
  eventTypes: EventType[];
  includeContent?: boolean;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  type: EventType;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: DeliveryError | null;
  lastDurationMs: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface WebhookTestResult {
  ok: boolean;
  statusCode: number | null;
  error: DeliveryError | null;
  durationMs: number;
}

// ---------- API campaigns (US3) ----------

export type ApiCampaignStatus = 'DRAFT' | 'LIVE' | 'PAUSED' | 'STOPPED';

export type VariableSource =
  | { source: 'value'; key: string }
  | { source: 'field'; key: string }
  | { source: 'static'; value: string };

export interface ApiCampaignInput {
  name: string;
  apiName: string;
  numberId: string;
  templateId: string;
  variableMapping?: Record<string, VariableSource>;
  headerMediaAssetId?: string | null;
  tags?: string[];
  attributes?: Record<string, unknown>;
  createContacts?: boolean;
  dailyLimit?: number | null;
}

export interface ApiCampaign {
  id: string;
  name: string;
  apiName: string;
  numberId: string;
  numberLabel: string;
  templateId: string;
  templateName: string;
  templateLanguage: string;
  templateCategory: string;
  templateStatus: string;
  /** The template's variable keys, e.g. BODY.1. */
  variables: string[];
  headerMediaType: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  wentLiveAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variableMapping: Record<string, VariableSource>;
  headerMediaAssetId: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  createContacts: boolean;
  dailyLimit: number | null;
  status: ApiCampaignStatus;
  pausedReason: 'TEMPLATE_UNAVAILABLE' | 'NUMBER_DISCONNECTED' | 'MEMBER' | null;
  callExample: string;
  todayTriggers: number;
}

export interface MessageCounts {
  triggers: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  clicked: number;
  notSent: number;
}

export interface ApiCampaignResults {
  from: string;
  to: string;
  totals: MessageCounts;
  days: Array<MessageCounts & { date: string }>;
  notSentReasons: Record<string, number>;
  failureReasons?: Record<string, number>;
}

export const API_CAMPAIGN_STATUS_LABEL: Record<ApiCampaignStatus, string> = { DRAFT: 'Draft', LIVE: 'Live', PAUSED: 'Paused', STOPPED: 'Stopped' };

export const API_CAMPAIGN_STATUS_VARIANT: Record<ApiCampaignStatus, 'secondary' | 'success' | 'warning' | 'outline'> = {
  DRAFT: 'secondary',
  LIVE: 'success',
  PAUSED: 'warning',
  STOPPED: 'outline',
};

/** Why a campaign paused, in plain words. */
export const PAUSED_REASON_LABEL: Record<NonNullable<ApiCampaign['pausedReason']>, string> = {
  MEMBER: 'Paused by a team member',
  TEMPLATE_UNAVAILABLE: 'Paused itself: its template is no longer approved',
  NUMBER_DISCONNECTED: 'Paused itself: its WhatsApp number is not connected',
};

/** Why a trigger was not sent (api_campaign_triggers.reason). */
export const NOT_SENT_LABEL: Record<string, string> = {
  not_live: 'Campaign not live',
  missing_value: 'A value was missing',
  invalid_phone: 'Not a valid phone number',
  invalid_value: 'An attribute value did not fit',
  opted_out: 'Contact opted out',
  no_opt_in: 'No opt-in (marketing template)',
  blocked: 'Contact blocked',
  not_a_contact: 'Not a contact',
  daily_limit: 'Daily limit reached',
  number_unavailable: 'Sending off for the number',
};

export const RESULT_LABELS: Array<[keyof MessageCounts, string]> = [
  ['triggers', 'Triggers'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['read', 'Read'],
  ['failed', 'Failed'],
  ['clicked', 'Clicked'],
  ['notSent', 'Not sent'],
];

// ---------- Stores (US4–US6) ----------

export type StorePlatform = 'SHOPIFY' | 'WOOCOMMERCE';
export type StoreStatus = 'CONNECTED' | 'ERROR' | 'DISCONNECTED';
export type StoreAutomationKind = 'ORDER_CONFIRMED' | 'ORDER_SHIPPED' | 'ORDER_DELIVERED' | 'ORDER_CANCELLED' | 'COD_CONFIRMATION' | 'CART_REMINDER';
export type CodStatus = 'NONE' | 'ASKED' | 'CONFIRMED' | 'CANCELLED' | 'NO_ANSWER' | 'CLOSED';
export type CartStatus = 'OPEN' | 'REMINDING' | 'RECOVERED' | 'STOPPED' | 'SKIPPED' | 'EXPIRED';

export interface StoreCredentials {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
}

export interface StoreConnectInput {
  platform: StorePlatform;
  baseUrl: string;
  numberId: string;
  defaultCountry: string;
  customerTag: string;
  credentials: StoreCredentials;
}

export interface Store {
  id: string;
  platform: StorePlatform;
  name: string;
  baseUrl: string;
  numberId: string;
  defaultCountry: string;
  customerTag: string;
  consentIsWhatsapp: boolean;
  shippedStatus: string | null;
  deliveredStatus: string | null;
  status: StoreStatus;
  lastError: string | null;
  lastEventAt: string | null;
  lastSyncedAt: string | null;
  automations: Array<{ kind: StoreAutomationKind; enabled: boolean }>;
}

export interface AutomationStep {
  templateId: string;
  variableMapping: Record<string, unknown>;
  waitMinutes?: number;
}

export interface CodSettings {
  confirmedReply?: string;
  cancelledReply?: string;
  alreadyAnsweredReply?: string;
  reminderMinutes?: number;
  finalMinutes?: number;
  autoCancel?: boolean;
}

export interface StoreAutomation {
  kind: StoreAutomationKind;
  enabled: boolean;
  steps: AutomationStep[];
  settings?: CodSettings;
  problems: Array<{ code: string; message: string }>;
}

export interface StoreAutomationResults {
  kind: StoreAutomationKind;
  counts: Record<string, number | string>;
  skipReasons: Record<string, number>;
}

export interface StoreOrderRow {
  id: string;
  orderNumber: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  total: string;
  currency: string;
  paymentKind: 'COD' | 'PREPAID' | 'UNPAID';
  status: string;
  codStatus: CodStatus;
  placedAt: string;
  messages: Array<{ kind: string; outcome: 'QUEUED' | 'SKIPPED'; skipReason: string | null; status: string | null }>;
}

export interface StoreCartRow {
  id: string;
  contact: { id: string; name: string | null; phone: string | null } | null;
  value: string;
  currency: string;
  status: CartStatus;
  stopReason: string | null;
  remindersSent: number;
  recoveredValue: string | null;
  startedAt: string;
}

// ---------- Chat links (US7) ----------

export interface ChatLinkInput {
  name: string;
  numberId: string;
  message: string;
  flowId?: string | null;
  tagId?: string | null;
}

export interface ChatLink {
  id: string;
  name: string;
  numberId: string;
  message: string;
  ref: string;
  shortUrl: string;
  whatsappUrl: string;
  flowId: string | null;
  tagId: string | null;
  status: 'ACTIVE' | 'OFF';
  opens: number;
  chatsStarted: number;
}

export interface ChatLinkResults {
  totals: { opens: number; chatsStarted: number; newContacts: number };
  days: Array<{ date: string; opens: number; chatsStarted: number; newContacts: number }>;
}

// ---------- Number wizard (US8) ----------

export type WizardCheckName =
  | 'TOKEN_VALID'
  | 'TOKEN_PERMISSIONS'
  | 'TOKEN_EXPIRY'
  | 'NUMBER_REGISTERED'
  | 'TWO_STEP_PIN'
  | 'DISPLAY_NAME'
  | 'QUALITY'
  | 'MESSAGING_LIMIT'
  | 'APP_SUBSCRIBED'
  | 'WEBHOOK_CALLBACK'
  | 'TEST_MESSAGE';

export interface WizardCheck {
  check: WizardCheckName;
  result: 'PASSED' | 'FAILED' | 'WARNING';
  detail: string;
  fix: string | null;
  fixAction: 'REGISTER_NUMBER' | 'SUBSCRIBE_APP' | null;
}

export interface WizardChecks {
  checks: WizardCheck[];
  ready: boolean;
}

export interface WizardSession {
  id: string;
  expiresAt: string;
  token: WizardCheck;
  accounts: Array<{
    wabaId: string;
    name: string;
    businessName: string | null;
    numbers: Array<{ phoneNumberId: string; displayPhoneNumber: string; verifiedName: string | null; alreadyConnected?: boolean }>;
  }>;
}

// ---------- Query keys ----------

export const integrationsKeys = {
  eventTypes: ['webhook-event-types'] as const,
  endpoints: ['webhook-endpoints'] as const,
  endpoint: (id: string) => ['webhook-endpoints', id] as const,
  deliveries: (id: string, page: number, status?: DeliveryStatus) => ['webhook-endpoints', id, 'deliveries', page, status ?? 'ALL'] as const,
  apiCampaigns: ['api-campaigns'] as const,
  apiCampaign: (id: string) => ['api-campaigns', id] as const,
  apiCampaignResults: (id: string) => ['api-campaigns', id, 'results'] as const,
  stores: ['stores'] as const,
  store: (id: string) => ['stores', id] as const,
  automation: (id: string, kind: StoreAutomationKind) => ['stores', id, 'automations', kind] as const,
  automationResults: (id: string, kind: StoreAutomationKind) => ['stores', id, 'automations', kind, 'results'] as const,
  orders: (id: string, page: number, codStatus?: CodStatus) => ['stores', id, 'orders', page, codStatus ?? 'ALL'] as const,
  carts: (id: string, page: number, status?: CartStatus) => ['stores', id, 'carts', page, status ?? 'ALL'] as const,
  chatLinks: ['chat-links'] as const,
  chatLink: (id: string) => ['chat-links', id] as const,
  chatLinkResults: (id: string) => ['chat-links', id, 'results'] as const,
  chatLinkContacts: (id: string, page: number) => ['chat-links', id, 'contacts', page] as const,
};

// ---------- Labels (our own wording) ----------

export const ENDPOINT_STATUS_LABEL: Record<WebhookEndpointStatus, string> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  FAILING: 'Failing',
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  PENDING: 'Waiting',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

export const DELIVERY_ERROR_LABEL: Record<DeliveryError, string> = {
  TIMEOUT: 'No answer within 10 seconds',
  BLOCKED_ADDRESS: 'The address is private or reserved',
  NETWORK: 'Could not connect',
  REDIRECT: 'The endpoint answered with a redirect',
  HTTP_4XX: 'The endpoint refused the event (4xx)',
  HTTP_5XX: 'The endpoint had an error (5xx)',
};

export const API_CAMPAIGN_STATUS_LABEL: Record<ApiCampaignStatus, string> = {
  DRAFT: 'Draft',
  LIVE: 'Live',
  PAUSED: 'Paused',
  STOPPED: 'Stopped',
};

export const NOT_SENT_REASON_LABEL: Record<string, string> = {
  opted_out: 'Opted out',
  no_opt_in: 'No marketing opt-in',
  missing_value: 'A value was missing',
  daily_limit: 'Daily limit reached',
  not_live: 'The campaign was not live',
  invalid_phone: 'Not a valid WhatsApp number',
  blocked: 'Blocked contact',
};

export const STORE_PLATFORM_LABEL: Record<StorePlatform, string> = {
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
};

export const STORE_STATUS_LABEL: Record<StoreStatus, string> = {
  CONNECTED: 'Connected',
  ERROR: 'Needs attention',
  DISCONNECTED: 'Disconnected',
};

export const AUTOMATION_KIND_LABEL: Record<StoreAutomationKind, string> = {
  ORDER_CONFIRMED: 'Order confirmed',
  ORDER_SHIPPED: 'Order shipped',
  ORDER_DELIVERED: 'Order delivered',
  ORDER_CANCELLED: 'Order cancelled',
  COD_CONFIRMATION: 'Cash-on-delivery confirmation',
  CART_REMINDER: 'Cart reminders',
};

export const COD_STATUS_LABEL: Record<CodStatus, string> = {
  NONE: '—',
  ASKED: 'Waiting for the customer',
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled by the customer',
  NO_ANSWER: 'No answer',
  CLOSED: 'Closed in the store',
};

export const CART_STATUS_LABEL: Record<CartStatus, string> = {
  OPEN: 'Open',
  REMINDING: 'Reminding',
  RECOVERED: 'Recovered',
  STOPPED: 'Stopped',
  SKIPPED: 'Skipped',
  EXPIRED: 'Expired',
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  no_phone: 'No WhatsApp number',
  opted_out: 'Opted out',
  no_opt_in: 'No marketing opt-in',
  no_consent: 'No WhatsApp marketing consent',
  stale: 'The store reported it more than 3 days late',
  blocked: 'Blocked contact',
  template_unavailable: 'The template is not approved',
  ordered: 'The customer ordered',
  replied: 'The customer wrote to us',
  store_disconnected: 'The store was disconnected',
  deleted: 'The contact was deleted',
};

export const WIZARD_CHECK_LABEL: Record<WizardCheckName, string> = {
  TOKEN_VALID: 'Access token',
  TOKEN_PERMISSIONS: 'Token permissions',
  TOKEN_EXPIRY: 'Token expiry',
  NUMBER_REGISTERED: 'Number registered for sending',
  TWO_STEP_PIN: 'Two-step PIN',
  DISPLAY_NAME: 'Display name',
  QUALITY: 'Quality rating',
  MESSAGING_LIMIT: 'Messaging limit',
  APP_SUBSCRIBED: 'App subscribed to the account',
  WEBHOOK_CALLBACK: 'Webhook address',
  TEST_MESSAGE: 'Test message',
};

export type { ApiKeyScope, EventType };
