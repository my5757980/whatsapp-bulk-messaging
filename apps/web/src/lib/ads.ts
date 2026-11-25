import type { AdGoal, AdSpecialCategoryName, AdsCheckName } from '@wbm/shared';

// Ads types, query keys and labels (feature 007, T017; contracts/ads-api.openapi.yaml). Money is in
// the ad account currency's minor units with its currency code, never converted.

// ---------- Connection (US1) ----------

export type AdsCheckResult = 'PASSED' | 'FAILED' | 'WARNING';

export interface AdsCheck {
  check: AdsCheckName;
  result: AdsCheckResult;
  detail: string;
  fix?: string | null;
}

export interface AdsChecks {
  checks: AdsCheck[];
  ready: boolean;
}

export interface AdsSession {
  id: string;
  expiresAt: string;
  token: AdsCheck;
  adAccounts: Array<{ id: string; name: string; currency: string; timezone: string | null; active: boolean }>;
  pages: Array<{ id: string; name: string }>;
}

export interface AdsConnection {
  adAccountId: string;
  adAccountName: string;
  pageId: string;
  pageName: string;
  currency: string;
  timezone: string;
  status: 'CONNECTED' | 'ERROR';
  checks: AdsChecks;
  checkedAt: string | null;
  monthlyCapMinor: number | null;
  monthSpendMinor: number;
  linkedNumberIds: string[];
  linkedNumbersKnown?: boolean;
}

// ---------- Campaigns (US2, US4, US5, US8) ----------

export type AdCampaignStatus = 'DRAFT' | 'SUBMITTING' | 'IN_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REJECTED' | 'ENDED' | 'ERROR';
export type AdVersionStatus = 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REJECTED' | 'ENDED';
export type CallToAction = 'WHATSAPP_MESSAGE' | 'SIGN_UP' | 'LEARN_MORE' | 'SHOP_NOW' | 'CONTACT_US';

export interface TargetingOption {
  key: string;
  name: string;
  type: string;
  countryCode?: string | null;
  audienceLower?: number | null;
  audienceUpper?: number | null;
}

export interface Targeting {
  locations: TargetingOption[];
  ageMin?: number;
  ageMax?: number;
  genders?: 'ALL' | 'MEN' | 'WOMEN';
  interests?: TargetingOption[];
  includeAudienceIds?: string[];
  excludeAudienceIds?: string[];
}

export interface Placements {
  auto: boolean;
  facebook?: Array<'feed' | 'story'>;
  instagram?: Array<'stream' | 'story'>;
  whatsappStatus?: boolean;
}

export interface AdVersionInput {
  mediaAssetId: string;
  primaryText: string;
  headline: string;
  callToAction: CallToAction;
}

export interface AdVersion extends AdVersionInput {
  id: string;
  position: number;
  mediaKind?: 'IMAGE' | 'VIDEO';
  status: AdVersionStatus;
  reviewFeedback?: string | null;
  metaAdId?: string | null;
  /** A rejected version edited since, waiting to be submitted again. */
  edited?: boolean;
}

export interface AdCampaignInput {
  name: string;
  goal: AdGoal;
  numberId?: string | null;
  prefilledMessage?: string | null;
  leadFormId?: string | null;
  websiteUrl?: string | null;
  targeting: Targeting;
  placements: Placements;
  specialCategory?: AdSpecialCategoryName;
  dailyBudgetMinor: number;
  startAt: string;
  endAt?: string | null;
  flowId?: string | null;
  tagId?: string | null;
  versions: AdVersionInput[];
}

export interface AdCampaignSummary {
  id: string;
  name: string;
  goal: AdGoal;
  status: AdCampaignStatus;
  dailyBudgetMinor: number;
  currency: string;
  startAt: string;
  endAt?: string | null;
  spendMinor: number;
  chatsStarted: number;
  leads: number;
}

export interface AdCampaign extends AdCampaignSummary {
  numberId?: string | null;
  prefilledMessage?: string | null;
  leadFormId?: string | null;
  websiteUrl?: string | null;
  linkUrl?: string | null;
  targeting: Targeting;
  placements: Placements;
  specialCategory: AdSpecialCategoryName;
  flowId?: string | null;
  tagId?: string | null;
  lastError?: string | null;
  syncedAt?: string | null;
  versions: AdVersion[];
}

export interface AdEstimate {
  audienceLower: number | null;
  audienceUpper: number | null;
  currency: string;
  minDailyBudgetMinor: number;
}

export interface AdResultNumbers {
  impressions: number;
  reach: number;
  clicks: number;
  ctr?: number | null;
  cpcMinor?: number | null;
  spendMinor: number;
  metaConversations?: number;
  chatsStarted: number;
  newContacts: number;
  replied: number;
  leads: number;
  visits?: number;
  costPerChatMinor?: number | null;
  costPerLeadMinor?: number | null;
}

export interface AdResults {
  currency: string;
  timezone: string;
  syncedAt?: string | null;
  totals: AdResultNumbers;
  days: Array<AdResultNumbers & { date: string }>;
  versions: Array<AdResultNumbers & { versionId: string }>;
}

// ---------- Chats from ads (US3) ----------

export interface AdChatStart {
  id: string;
  contact?: { id: string; name: string | null; phone: string | null } | null;
  conversationId?: string | null;
  newContact: boolean;
  startedAt: string;
  metaAdId?: string;
  headline?: string | null;
}

export interface AdReferral {
  metaAdId: string;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  sourceUrl: string | null;
  adCampaignId?: string | null;
  adCampaignName?: string | null;
}

export type FreeWindowState =
  | { state: 'REPLY_TO_OPEN'; replyBy: string }
  | { state: 'OPEN'; until: string }
  | { state: 'ENDED'; until: string }
  | { state: 'MISSED' };

/** The latest ad a chat came from, on the live chat detail (002 ConversationDetail.adChat). */
export interface AdChat {
  metaAdId: string;
  headline: string | null;
  body: string | null;
  mediaUrl: string | null;
  sourceUrl: string | null;
  startedAt: string;
  newContact: boolean;
  adCampaign: { id: string; name: string } | null;
  freeWindow: FreeWindowState;
}

// ---------- Audiences (US6) and lead forms (US7) ----------

export interface AdAudience {
  id: string;
  name: string;
  kind: 'CUSTOM' | 'LOOKALIKE';
  source?: Record<string, unknown> | null;
  originAudienceId?: string | null;
  lookalikeCountry?: string | null;
  lookalikeRatio?: number | null;
  status: 'SYNCING' | 'READY' | 'TOO_SMALL' | 'ERROR';
  memberCount: number;
  lastError?: string | null;
  syncedAt?: string | null;
}

export interface AdLeadForm {
  id: string;
  name: string;
  questions: { standard: Array<'FULL_NAME' | 'PHONE' | 'EMAIL'>; custom?: Array<{ key: string; label: string }> };
  privacyUrl: string;
  consentText: string;
  tagId?: string | null;
  welcomeTemplateId?: string | null;
  welcomeMapping?: Record<string, string>;
  metaFormId?: string | null;
  leads: number;
  lastLeadAt?: string | null;
}

export interface AdLead {
  id: string;
  answers?: Record<string, string>;
  phone?: string | null;
  email?: string | null;
  consent: boolean;
  status: 'PROCESSED' | 'NO_PHONE' | 'INVALID_PHONE' | 'FAILED';
  contactId?: string | null;
  submittedAt: string;
}

// ---------- Query keys ----------

export const adsKeys = {
  connection: ['ads', 'connection'] as const,
  campaigns: ['ads', 'campaigns'] as const,
  campaign: (id: string) => ['ads', 'campaigns', id] as const,
  results: (id: string, from?: string, to?: string) => ['ads', 'campaigns', id, 'results', from ?? '', to ?? ''] as const,
  chats: (id: string, page: number) => ['ads', 'campaigns', id, 'chats', page] as const,
  otherChats: (page: number) => ['ads', 'other-chats', page] as const,
  audiences: ['ads', 'audiences'] as const,
  leadForms: ['ads', 'lead-forms'] as const,
  leads: (id: string, page: number) => ['ads', 'lead-forms', id, 'leads', page] as const,
};

// ---------- Labels ----------

export const ADS_CHECK_LABEL: Record<AdsCheckName, string> = {
  TOKEN_VALID: 'Access token',
  TOKEN_PERMISSIONS: 'Token permissions',
  TOKEN_EXPIRY: 'Token expiry',
  AD_ACCOUNT_ACTIVE: 'Ad account active',
  AD_ACCOUNT_PAYMENT: 'Payment method',
  AD_ACCOUNT_CURRENCY: 'Currency and time zone',
  PAGE_ADS: 'Page can run ads',
  PAGE_WHATSAPP_NUMBERS: 'WhatsApp numbers linked to the page',
  AUDIENCE_TERMS: 'Custom audience terms',
  LEAD_TERMS: 'Lead ads terms',
};

export const AD_GOAL_LABEL: Record<AdGoal, string> = {
  CHATS: 'Start WhatsApp chats',
  LEADS: 'Collect leads with a form',
  WEBSITE: 'Visits to a web page',
};

export const AD_STATUS_LABEL: Record<AdCampaignStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTING: 'Submitting',
  IN_REVIEW: 'In review',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  REJECTED: 'Rejected',
  ENDED: 'Ended',
  ERROR: 'Error',
};

export const AD_STATUS_VARIANT: Record<AdCampaignStatus, 'outline' | 'secondary' | 'default' | 'warning' | 'success' | 'destructive'> = {
  DRAFT: 'outline',
  SUBMITTING: 'secondary',
  IN_REVIEW: 'secondary',
  ACTIVE: 'success',
  PAUSED: 'warning',
  REJECTED: 'destructive',
  ENDED: 'outline',
  ERROR: 'destructive',
};

export const CALL_TO_ACTION_LABEL: Record<CallToAction, string> = {
  WHATSAPP_MESSAGE: 'Send WhatsApp message',
  SIGN_UP: 'Sign up',
  LEARN_MORE: 'Learn more',
  SHOP_NOW: 'Shop now',
  CONTACT_US: 'Contact us',
};

export const SPECIAL_CATEGORY_LABEL: Record<AdSpecialCategoryName, string> = {
  NONE: 'None',
  CREDIT: 'Credit',
  EMPLOYMENT: 'Employment',
  HOUSING: 'Housing',
  SOCIAL_ISSUES: 'Social issues, elections or politics',
};

/** An amount in minor units with its currency, e.g. "AED 50.00". */
export function money(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '—';
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(minor / 10 ** digits);
}

/** Minor units → major units for a form field. */
export function toMajorUnits(minor: number, currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return minor / 10 ** digits;
}

/** Major units typed in a form → minor units. */
export function toMinorUnits(major: number, currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return Math.round(major * 10 ** digits);
}
