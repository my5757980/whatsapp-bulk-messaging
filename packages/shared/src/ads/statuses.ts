// Meta's delivery states mapped to the platform's (feature 007, FR-012, FR-017, research R6).

export type AdCampaignState = 'DRAFT' | 'SUBMITTING' | 'IN_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REJECTED' | 'ENDED' | 'ERROR';
export type AdVersionState = 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'PAUSED' | 'REJECTED' | 'ENDED';

/** Meta states that mean the account or the ad has a problem to fix (billing, policy issues). */
export const DELIVERY_PROBLEM_STATUSES = ['WITH_ISSUES', 'PENDING_BILLING_INFO'] as const;

/** One ad's state; null keeps the version as it was (a problem shown on the campaign instead). */
export function versionStateFrom(effectiveStatus: string): AdVersionState | null {
  switch (effectiveStatus) {
    case 'PENDING_REVIEW':
    case 'IN_PROCESS':
    case 'PREAPPROVED':
      return 'IN_REVIEW';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'PAUSED':
    case 'CAMPAIGN_PAUSED':
    case 'ADSET_PAUSED':
      return 'PAUSED';
    case 'DISAPPROVED':
      return 'REJECTED';
    case 'ARCHIVED':
    case 'DELETED':
      return 'ENDED';
    default:
      return null;
  }
}

/** The campaign's state from Meta's campaign and ad set states and its versions. */
export function campaignStateFrom(input: {
  campaignStatus: string;
  adsetStatus?: string | null;
  versions: readonly AdVersionState[];
  endAt: Date | null;
  now: Date;
}): AdCampaignState {
  const statuses = [input.campaignStatus, input.adsetStatus ?? ''];
  if (input.endAt && input.endAt.getTime() <= input.now.getTime()) return 'ENDED';
  if (statuses.some((s) => s === 'ARCHIVED' || s === 'DELETED')) return 'ENDED';
  if (statuses.some((s) => (DELIVERY_PROBLEM_STATUSES as readonly string[]).includes(s))) return 'ERROR';
  if (statuses.some((s) => s === 'PAUSED' || s === 'CAMPAIGN_PAUSED' || s === 'ADSET_PAUSED')) return 'PAUSED';
  const v = input.versions;
  if (v.length && v.every((s) => s === 'REJECTED')) return 'REJECTED';
  if (v.some((s) => s === 'ACTIVE')) return 'ACTIVE';
  if (v.some((s) => s === 'IN_REVIEW')) return 'IN_REVIEW';
  if (v.length && v.every((s) => s === 'PAUSED' || s === 'REJECTED')) return 'PAUSED';
  return 'IN_REVIEW';
}

/** States in which the platform keeps reading Meta's state. */
export const SYNCED_CAMPAIGN_STATES: readonly AdCampaignState[] = ['IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ERROR'];
