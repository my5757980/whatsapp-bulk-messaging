import type { QuietHours } from '@wbm/shared';

// Campaign growth types and query keys (feature 005, T014; contracts/growth-api.openapi.yaml).

export interface TrackedLinkConfig {
  /** False when the company's tracked-link address is not set up; links cannot be tracked then. */
  enabled: boolean;
  baseUrl: string | null;
  /** The URL button address a template needs, for example https://go.company.example/l/{{1}}. */
  buttonUrl: string | null;
}

export interface TrackedLinkTarget {
  id: string;
  variableKey: string;
  destination: string;
  addCampaignTags: boolean;
}

export interface TrackableVariable {
  variableKey: string;
  kind: 'URL_BUTTON' | 'TEXT_VARIABLE';
  trackable: boolean;
  reason: string | null;
}

export interface TrackedLinkSet {
  links: TrackedLinkTarget[];
  trackable: TrackableVariable[];
}

export interface TrackedLinkInput {
  variableKey: string;
  destination: string;
  addCampaignTags?: boolean;
}

export interface ClickSummary {
  clickers: number;
  clicks: number;
  delivered: number;
  clickRate: number;
  links: Array<{ targetId: string; variableKey: string; destination: string; clickers: number; clicks: number }>;
}

export interface Clicker {
  contactId: string | null;
  name: string | null;
  phone: string | null;
  firstClickAt: string;
  lastClickAt: string;
  clicks: number;
}

export type RetargetGroup = 'FAILED' | 'NOT_READ' | 'READ' | 'DELIVERED' | 'CLICKED' | 'NOT_CLICKED' | 'REPLIED' | 'NOT_REPLIED' | 'HELD_BACK';

export interface RetryPlan {
  rounds: number;
  delaysMinutes: number[];
}

export type RetryRoundStatus = 'SCHEDULED' | 'RUNNING' | 'DONE' | 'CANCELLED' | 'SKIPPED';

export interface RetryRound {
  round: number;
  status: RetryRoundStatus;
  dueAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recipients: number;
  recovered: number;
  note: string | null;
}

export type DripStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type DripTriggerKind = 'TAG_ADDED' | 'OPTED_IN' | 'IMPORTED' | 'API_CREATED' | 'LINK_CLICKED';

export interface DripTrigger {
  kind: DripTriggerKind;
  tagId?: string | null;
  /** LINK_CLICKED only; null means any campaign. */
  campaignId?: string | null;
}

export interface DripSummary {
  id: string;
  name: string;
  status: DripStatus;
  pausedReason: string | null;
  number: { id: string; label: string };
  steps: number;
  active: number;
  finished: number;
  left: number;
  updatedAt: string;
}

export interface DripStep {
  id: string;
  position: number;
  template: { id: string; name: string; language: string; status: string };
  variableMapping: Record<string, unknown>;
  headerMediaAssetId: string | null;
  waitMinutes: number;
  trackedLinks: TrackedLinkTarget[];
}

export interface DripProblem {
  code: string;
  message: string;
  stepPosition?: number | null;
}

export interface DripDetail extends DripSummary {
  quietHours: QuietHours | null;
  leaveOnReply: boolean;
  leaveOnClick: boolean;
  stopTagIds: string[];
  allowRejoin: boolean;
  triggers: DripTrigger[];
  stepList: DripStep[];
  problems: DripProblem[];
}

export interface DripStepInput {
  id?: string | null;
  templateId: string;
  variableMapping: Record<string, unknown>;
  headerMediaAssetId?: string | null;
  waitMinutes: number;
  trackedLinks?: TrackedLinkInput[];
}

export interface ContactRow {
  id: string | null;
  name: string | null;
  phone: string | null;
}

export type EnrolmentStatus = 'ACTIVE' | 'FINISHED' | 'LEFT';
export type DripJoinVia = DripTriggerKind | 'MANUAL';
export type DripLeftReason = 'REPLIED' | 'OPTED_OUT' | 'BLOCKED' | 'DELETED' | 'STOP_TAG' | 'CLICKED' | 'REMOVED' | 'INVALID_NUMBER' | 'ARCHIVED';

export interface Enrolment {
  id: string;
  contact: ContactRow;
  status: EnrolmentStatus;
  joinedVia: DripJoinVia;
  currentPosition: number;
  nextDueAt: string | null;
  leftReason: DripLeftReason | null;
  joinedAt: string;
  endedAt: string | null;
}

export interface EnrolResult {
  enrolled: number;
  skippedOptedOut: number;
  skippedAlreadyIn: number;
  skippedNotFound: number;
}

export type StepMetric = 'SENT' | 'DELIVERED' | 'READ' | 'CLICKED' | 'REPLIED' | 'FAILED' | 'SKIPPED';

export interface DripResults {
  active: number;
  finished: number;
  left: Partial<Record<DripLeftReason, number>>;
  steps: Array<{
    stepId: string;
    position: number;
    templateName: string;
    removed: boolean;
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    replied: number;
    failed: number;
    skipped: number;
  }>;
}

export const growthKeys = {
  linkConfig: ['tracked-links', 'config'] as const,
  trackedLinks: (campaignId: string) => ['campaigns', campaignId, 'tracked-links'] as const,
  clickSummary: (campaignId: string) => ['campaigns', campaignId, 'clicks', 'summary'] as const,
  clickers: (campaignId: string, page: number) => ['campaigns', campaignId, 'clicks', page] as const,
  retargetGroups: (campaignId: string) => ['campaigns', campaignId, 'retarget-groups'] as const,
  retryPlan: (campaignId: string) => ['campaigns', campaignId, 'retry-plan'] as const,
  retryRounds: (campaignId: string) => ['campaigns', campaignId, 'retry-rounds'] as const,
  allRetryRounds: ['retry-rounds'] as const,
  drips: ['drips'] as const,
  dripList: ['drips', 'list'] as const,
  drip: (id: string) => ['drips', 'detail', id] as const,
  enrolments: (id: string, page: number, status?: string) => ['drips', 'detail', id, 'enrolments', page, status ?? 'ALL'] as const,
  dripResults: (id: string) => ['drips', 'detail', id, 'results'] as const,
};

export const DRIP_STATUS_LABEL: Record<DripStatus, string> = { DRAFT: 'Draft', ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived' };
export const DRIP_STATUS_VARIANT: Record<DripStatus, 'secondary' | 'default' | 'outline' | 'destructive'> = {
  DRAFT: 'secondary',
  ACTIVE: 'default',
  PAUSED: 'outline',
  ARCHIVED: 'secondary',
};

/** Waits a step can have, in minutes (feature 005, FR-020): right away is for the first step only. */
export const STEP_WAITS: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: 'Right away' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '1 day' },
  { minutes: 2880, label: '2 days' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '1 week' },
  { minutes: 20160, label: '2 weeks' },
  { minutes: 43200, label: '30 days' },
];

/** Plain-words labels for why a contact left a drip. */
export const LEFT_REASON_LABEL: Record<DripLeftReason, string> = {
  REPLIED: 'Replied',
  OPTED_OUT: 'Opted out',
  BLOCKED: 'Blocked',
  DELETED: 'Contact deleted',
  STOP_TAG: 'Stop tag added',
  CLICKED: 'Clicked a link',
  REMOVED: 'Removed by a member',
  INVALID_NUMBER: 'Number not on WhatsApp',
  ARCHIVED: 'Drip archived',
};
