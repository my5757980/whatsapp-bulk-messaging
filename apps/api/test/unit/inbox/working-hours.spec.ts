import { describe, expect, it } from 'vitest';
import { isWithinHours, type WorkingHours } from '../../../src/modules/inbox/automation/working-hours.js';
import { LiveChatSettingsSchema } from '../../../src/modules/inbox/settings/live-chat-settings.service.js';

// T075: working hours in an IANA time zone (FR-035, research R10).
const weekdays: WorkingHours = {
  mon: [['09:00', '13:00'], ['14:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '12:00']],
  sat: [],
  sun: [],
};

describe('isWithinHours', () => {
  it('uses the configured time zone', () => {
    // 2026-11-23 is a Monday. 05:30 UTC is 09:30 in Dubai (UTC+4).
    expect(isWithinHours(weekdays, 'Asia/Dubai', new Date('2026-11-23T05:30:00Z'))).toBe(true);
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T05:30:00Z'))).toBe(false);
  });

  it('supports several ranges a day, with the start inside and the end outside', () => {
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T09:00:00Z'))).toBe(true);
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T12:59:59Z'))).toBe(true);
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T13:30:00Z'))).toBe(false); // lunch break
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T17:59:00Z'))).toBe(true);
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-23T18:00:00Z'))).toBe(false);
  });

  it('treats a day without ranges as closed', () => {
    expect(isWithinHours(weekdays, 'UTC', new Date('2026-11-28T10:00:00Z'))).toBe(false); // Saturday
  });

  it('follows daylight saving time', () => {
    // New York: 09:30 local is 14:30 UTC in winter (EST) and 13:30 UTC in summer (EDT).
    const allWeek: WorkingHours = { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '17:00']], sat: [], sun: [] };
    expect(isWithinHours(allWeek, 'America/New_York', new Date('2026-01-14T14:30:00Z'))).toBe(true);
    expect(isWithinHours(allWeek, 'America/New_York', new Date('2026-07-15T13:30:00Z'))).toBe(true);
    expect(isWithinHours(allWeek, 'America/New_York', new Date('2026-01-14T13:30:00Z'))).toBe(false);
  });
});

describe('working hours validation', () => {
  const base = { timezone: 'Asia/Dubai', welcomeEnabled: false, offHoursEnabled: false, humanKeywords: [], autoResolve: false };
  const parse = (workingHours: Record<string, unknown>) => LiveChatSettingsSchema.safeParse({ ...base, workingHours });

  it('accepts valid ranges and closed days', () => {
    expect(parse(weekdays).success).toBe(true);
  });

  it('rejects overlapping ranges, a start not before the end, and bad times', () => {
    expect(parse({ mon: [['09:00', '13:00'], ['12:00', '18:00']] }).success).toBe(false);
    expect(parse({ mon: [['18:00', '09:00']] }).success).toBe(false);
    expect(parse({ mon: [['9:00', '18:00']] }).success).toBe(false);
  });

  it('rejects unknown time zones', () => {
    expect(LiveChatSettingsSchema.safeParse({ ...base, timezone: 'Mars/Olympus', workingHours: {} }).success).toBe(false);
  });
});
