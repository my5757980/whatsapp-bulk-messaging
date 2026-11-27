// Payment reminders (feature 008, research R6): up to two, each "N minutes before expiry", sent at
// most once. `processed` counts the reminder slots already sent or skipped, in time order. Pure.
import { PAYMENT_LIMITS } from './payments.js';

export interface ReminderRule {
  beforeMinutes: number;
}

export const REMINDER_LIMITS = { beforeMinutesMin: 15, beforeMinutesMax: PAYMENT_LIMITS.expiryMinutesMax - 30 } as const;

/** Rules in time order: the one furthest before expiry comes first. */
export function orderedReminders<T extends ReminderRule>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => b.beforeMinutes - a.beforeMinutes);
}

/**
 * The next reminder still to send: its slot (index in time order) and due time, or null. A reminder
 * that would fall at or before the request's creation is skipped.
 */
export function nextReminder(input: { createdAt: number; expiresAt: number; rules: readonly ReminderRule[]; processed: number }): { slot: number; at: number } | null {
  const rules = orderedReminders(input.rules);
  for (let slot = Math.max(0, input.processed); slot < rules.length; slot += 1) {
    const at = input.expiresAt - (rules[slot]?.beforeMinutes ?? 0) * 60_000;
    if (at > input.createdAt && at < input.expiresAt) return { slot, at };
  }
  return null;
}

export function reminderRulesProblem(rules: readonly ReminderRule[]): string | null {
  if (rules.length > PAYMENT_LIMITS.remindersMax) return 'At most two reminders';
  for (const rule of rules) {
    if (!Number.isInteger(rule.beforeMinutes) || rule.beforeMinutes < REMINDER_LIMITS.beforeMinutesMin || rule.beforeMinutes > REMINDER_LIMITS.beforeMinutesMax) {
      return `A reminder must be ${REMINDER_LIMITS.beforeMinutesMin} to ${REMINDER_LIMITS.beforeMinutesMax} minutes before expiry`;
    }
  }
  if (new Set(rules.map((r) => r.beforeMinutes)).size !== rules.length) return 'The two reminders need different times';
  return null;
}
