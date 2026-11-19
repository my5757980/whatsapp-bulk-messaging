import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { normalizeKeyword } from '../../webhooks/handlers/inbound.handler.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Up to 4 ranges a day, HH:MM, start before end, no overlaps (data-model §1). */
const DayHoursSchema = z
  .array(z.tuple([z.string().regex(HHMM, 'use HH:MM'), z.string().regex(HHMM, 'use HH:MM')]))
  .max(4)
  .superRefine((ranges, ctx) => {
    const sorted = [...ranges].sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([start, end], i) => {
      if (start >= end) ctx.addIssue({ code: 'custom', message: `${start}-${end}: the start must be before the end` });
      const next = sorted[i + 1];
      if (next && next[0] < end) ctx.addIssue({ code: 'custom', message: `${start}-${end} overlaps ${next[0]}-${next[1]}` });
    });
  });

/** Welcome and off-hours content (data-model §3); fully checked when used (US6). */
export const AutoContentSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('TEMPLATE'), templateId: z.uuid(), variables: z.record(z.string(), z.unknown()).default({}) }),
    z.strictObject({ kind: z.literal('TEXT'), text: z.string().trim().min(1).max(4096) }),
    z.strictObject({ kind: z.enum(['IMAGE', 'FILE']), mediaAssetId: z.uuid(), text: z.string().max(4096).optional() }),
  ])
  .nullable();
export type AutoContent = z.infer<typeof AutoContentSchema>;

/** PUT /live-chat/settings (contracts/inbox-api.openapi.yaml LiveChatSettings). */
export const LiveChatSettingsSchema = z
  .object({
    timezone: z.string().refine(isValidTimezone, 'is not a valid IANA time zone'),
    workingHours: z.object({
      mon: DayHoursSchema.default([]),
      tue: DayHoursSchema.default([]),
      wed: DayHoursSchema.default([]),
      thu: DayHoursSchema.default([]),
      fri: DayHoursSchema.default([]),
      sat: DayHoursSchema.default([]),
      sun: DayHoursSchema.default([]),
    }),
    welcomeEnabled: z.boolean(),
    welcomeContent: AutoContentSchema.optional(),
    offHoursEnabled: z.boolean(),
    offHoursContent: AutoContentSchema.optional(),
    humanKeywords: z
      .array(z.string().trim().min(1).max(60))
      .max(5, 'at most 5 keywords')
      .transform((list) => [...new Set(list.map((k) => normalizeKeyword(k)))]),
    autoResolve: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.welcomeEnabled && !value.welcomeContent) ctx.addIssue({ code: 'custom', path: ['welcomeContent'], message: 'is required when the welcome message is on' });
    if (value.offHoursEnabled && !value.offHoursContent) ctx.addIssue({ code: 'custom', path: ['offHoursContent'], message: 'is required when the off-hours message is on' });
  });
export type LiveChatSettingsInput = z.infer<typeof LiveChatSettingsSchema>;

export interface LiveChatSettingsDto {
  timezone: string;
  workingHours: Record<Weekday, Array<[string, string]>>;
  welcomeEnabled: boolean;
  welcomeContent: AutoContent;
  offHoursEnabled: boolean;
  offHoursContent: AutoContent;
  humanKeywords: string[];
  autoResolve: boolean;
}

/**
 * Live chat settings, one row (T048): "talk to a person" keywords, auto-resolve, and the working
 * hours and automatic messages used by US6. Created on first use from the company time zone.
 */
@Injectable()
export class LiveChatSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<LiveChatSettingsDto> {
    const row = await this.prisma.liveChatSettings.findUnique({ where: { id: 1 } });
    if (row) return toDto(row);
    const company = await this.prisma.settings.findUnique({ where: { id: 1 }, select: { defaultTimezone: true } });
    const created = await this.prisma.liveChatSettings.upsert({ where: { id: 1 }, create: { id: 1, timezone: company?.defaultTimezone ?? 'UTC' }, update: {} });
    return toDto(created);
  }

  async update(input: LiveChatSettingsInput, actorId: string): Promise<LiveChatSettingsDto> {
    await this.get();
    const row = await this.prisma.liveChatSettings.update({
      where: { id: 1 },
      data: {
        timezone: input.timezone,
        workingHours: input.workingHours as Prisma.InputJsonValue,
        welcomeEnabled: input.welcomeEnabled,
        welcomeContent: (input.welcomeContent ?? null) as Prisma.InputJsonValue,
        offHoursEnabled: input.offHoursEnabled,
        offHoursContent: (input.offHoursContent ?? null) as Prisma.InputJsonValue,
        humanKeywords: input.humanKeywords,
        autoResolve: input.autoResolve,
        updatedById: actorId,
      },
    });
    return toDto(row);
  }
}

function toDto(row: Prisma.LiveChatSettingsGetPayload<object>): LiveChatSettingsDto {
  const hours = (row.workingHours ?? {}) as Partial<Record<Weekday, Array<[string, string]>>>;
  return {
    timezone: row.timezone,
    workingHours: Object.fromEntries(WEEKDAYS.map((d) => [d, hours[d] ?? []])) as Record<Weekday, Array<[string, string]>>,
    welcomeEnabled: row.welcomeEnabled,
    welcomeContent: (row.welcomeContent ?? null) as AutoContent,
    offHoursEnabled: row.offHoursEnabled,
    offHoursContent: (row.offHoursContent ?? null) as AutoContent,
    humanKeywords: row.humanKeywords,
    autoResolve: row.autoResolve,
  };
}
