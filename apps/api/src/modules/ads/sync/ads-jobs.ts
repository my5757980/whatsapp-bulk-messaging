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

/** Meta's numbers for running campaigns, hourly (R7); then the spending cap is checked. */
export const ADS_INSIGHTS_JOB = 'ads-insights';
export const ADS_INSIGHTS_EVERY_MS = 60 * 60_000;

/** Meta updates attribution for up to 28 days: once a day, the last 28 days of campaigns that ran. */
export const ADS_INSIGHTS_DAILY_JOB = 'ads-insights-daily';
export const ADS_INSIGHTS_DAILY_EVERY_MS = 24 * 60 * 60_000;
export const ADS_REFRESH_DAYS = 28;

/** Saved audiences: every CUSTOM audience once a day, sending only the difference (R8). */
export const ADS_AUDIENCES_JOB = 'ads-audiences';
export const ADS_AUDIENCES_EVERY_MS = 24 * 60 * 60_000;

/** One audience now: after it is made, or when someone asks (POST /ads/audiences/{id}/sync). */
export const ADS_AUDIENCE_SYNC_JOB = 'ads-audience-sync';
export interface AdsAudienceSyncData {
  audienceId: string;
}

/** A campaign's first numbers, read shortly after it becomes active rather than at the next hour. */
export const ADS_INSIGHTS_ONE_JOB = 'ads-insights-one';
export const ADS_FIRST_INSIGHTS_DELAY_MS = 30_000;
export interface AdsInsightsOneData {
  campaignId: string;
}
