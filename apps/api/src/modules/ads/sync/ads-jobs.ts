// Job names of the `ads` queue (feature 007, plan Technical Context), shared by the HTTP app (which
// queues follow-up status reads after a submit) and the worker (which runs them).

/** Every campaign in review, active, paused, rejected or in error: every 5 minutes (R6). */
export const ADS_STATUS_JOB = 'ads-status';
export const ADS_STATUS_EVERY_MS = 5 * 60_000;

/** One campaign right after a submit, until Meta's review ends, so the state shows within a minute. */
export const ADS_STATUS_ONE_JOB = 'ads-status-one';
export const ADS_FOLLOW_UP_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000] as const;

export interface AdsStatusOneData {
  campaignId: string;
  attempt: number;
}
