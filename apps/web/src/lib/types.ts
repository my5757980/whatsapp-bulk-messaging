// Response shapes of the dashboard API used by the web app (contracts/dashboard-api.openapi.yaml).
import type { CampaignState, MessageStatus, TemplateCategory, TemplateStatus } from '@wbm/shared';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface Paged<T> {
  items: T[];
  page: PageMeta;
}

export interface WhatsAppNumber {
  id: string;
  label: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  connectionStatus: 'CONNECTED' | 'ERROR' | 'DISCONNECTED';
  qualityRating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  messagingLimitTier: string | null;
  throughputLevel: string | null;
  sendRatePerSecond: number;
  sendingEnabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface TemplateVariable {
  key: string;
  example: string;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type: string; text?: string; url?: string }>;
}

export interface Template {
  id: string;
  wabaId: string;
  metaTemplateId: string | null;
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat: 'POSITIONAL' | 'NAMED';
  status: TemplateStatus;
  rejectionReason: string | null;
  components: TemplateComponent[];
  variables: TemplateVariable[];
  lastSyncedAt: string | null;
}

export interface StatusTotals {
  pending: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export type VariableSourceKind = 'column' | 'field' | 'attribute' | 'static';

export interface VariableSource {
  source: VariableSourceKind;
  key?: string;
  value?: string;
  fallback?: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  numberId?: string;
  templateId?: string;
  audienceType: 'FILTER' | 'ALL_OPTED_IN' | 'UPLOAD' | 'RETARGET';
  audienceFilter?: AudienceFilter;
  sourceCampaignId?: string | null;
  retargetStatus?: 'FAILED' | 'NOT_READ' | 'READ' | 'DELIVERED' | null;
  variableMapping: Record<string, VariableSource>;
  headerMediaAssetId: string | null;
  state: CampaignState;
  scheduledAt: string | null;
  timezone: string;
  pausedReason: string | null;
  pausedReasonText: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  totals: StatusTotals;
  estimatedCostUsd: number;
  templateName: string | null;
  numberLabel: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CampaignMessage {
  id: string;
  origin: 'CAMPAIGN' | 'API';
  phone: string | null;
  contactId: string | null;
  contactName: string | null;
  status: MessageStatus;
  skipReason: string | null;
  failureCode: number | null;
  failureReason: string | null;
  attempts: number;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
}

export interface ImportJob {
  id: string;
  kind: 'CONTACTS' | 'CAMPAIGN_AUDIENCE';
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  columns: string[];
  hasErrorReport: boolean;
  error: string | null;
  finishedAt: string | null;
}

export interface Estimate {
  eligible: number;
  excluded: { optedOut: number; noOptIn: number; invalidNumber: number; duplicate: number; missingVariable: number };
  messagingLimitWarning: string | null;
  previews: Array<{ phoneMasked: string; text: string }>;
  estimatedCostUsd?: number;
  uncostedRecipients?: number;
}

export interface CampaignDetail extends Campaign {
  audienceUpload: ImportJob | null;
}

export type ConsentStatusValue = 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';

export interface Contact {
  id: string;
  phone: string;
  countryCode: string;
  name: string | null;
  tags: string[];
  attributes: Record<string, string | number | boolean>;
  consentStatus: ConsentStatusValue;
  consentSource: string | null;
  consentAt: string | null;
  createdAt: string;
}

export interface ContactDetail extends Contact {
  consentHistory: Array<{ status: ConsentStatusValue; source: string; note: string | null; createdAt: string }>;
}

export interface Tag {
  id: string;
  name: string;
  contactCount: number;
}

export type AttributeType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN';

export interface AttributeDefinition {
  id: string;
  key: string;
  label: string;
  type: AttributeType;
}

export type AttributeOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'before' | 'after' | 'is_true' | 'is_false';
export type AudienceRule = { tag: string } | { attr: string; op: AttributeOperator; value?: string };
export interface AudienceFilter {
  all: AudienceRule[];
}

export interface AudienceCounts {
  eligible: number;
  excluded: Estimate['excluded'];
}

export interface CompanySettings {
  defaultCountryCode: string;
  defaultTimezone: string;
  optOutKeywords: string[];
  optInKeywords: string[];
}
