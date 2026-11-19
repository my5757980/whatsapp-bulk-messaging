import type { Job } from 'bullmq';

/**
 * True on the last attempt BullMQ will make for this job. `attemptsMade` counts the attempts that
 * already failed, so the first run sees 0.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}
