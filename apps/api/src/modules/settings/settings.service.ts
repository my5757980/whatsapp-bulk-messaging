import { Body, Controller, Get, Global, Injectable, Module, Patch, Req } from '@nestjs/common';
import { isSupportedCountry } from 'libphonenumber-js';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AuditService } from '../audit/audit.service.js';

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const keywordList = z
  .array(z.string().trim().min(1).max(30))
  .max(20)
  .transform((list) => [...new Set(list.map((k) => k.toUpperCase().replace(/\s+/g, ' ')))]);

export const SettingsPatchSchema = z
  .object({
    defaultCountryCode: z
      .string()
      .length(2)
      .transform((c) => c.toUpperCase())
      .refine((c) => isSupportedCountry(c), 'is not a supported country code')
      .optional(),
    defaultTimezone: z.string().refine(isValidTimezone, 'is not a valid IANA timezone').optional(),
    optOutKeywords: keywordList.refine((l) => l.length > 0, 'needs at least one keyword').optional(),
    optInKeywords: keywordList.optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export interface CompanySettings {
  defaultCountryCode: string;
  defaultTimezone: string;
  optOutKeywords: string[];
  optInKeywords: string[];
}

/** Company settings singleton (FR-004, FR-013, T052). */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<CompanySettings> {
    const row = await this.prisma.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    return {
      defaultCountryCode: row.defaultCountryCode,
      defaultTimezone: row.defaultTimezone,
      optOutKeywords: row.optOutKeywords,
      optInKeywords: row.optInKeywords,
    };
  }

  async update(patch: SettingsPatch): Promise<CompanySettings> {
    const current = await this.get();
    const optOut = patch.optOutKeywords ?? current.optOutKeywords;
    const optIn = patch.optInKeywords ?? current.optInKeywords;
    const overlap = optIn.filter((k) => optOut.includes(k));
    if (overlap.length) {
      throw new z.ZodError([
        { code: 'custom', path: ['optInKeywords'], message: `overlaps opt-out keywords: ${overlap.join(', ')}`, input: optIn },
      ]);
    }
    await this.prisma.settings.update({
      where: { id: 1 },
      data: {
        ...(patch.defaultCountryCode ? { defaultCountryCode: patch.defaultCountryCode } : {}),
        ...(patch.defaultTimezone ? { defaultTimezone: patch.defaultTimezone } : {}),
        optOutKeywords: optOut,
        optInKeywords: optIn,
      },
    });
    return this.get();
  }
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Require('settings.view')
  get() {
    return this.settings.get();
  }

  @Patch()
  @Require('settings.manage')
  async update(
    @Body(new ZodValidationPipe(SettingsPatchSchema)) body: SettingsPatch,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    const updated = await this.settings.update(body);
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'settings.updated', { type: 'settings', id: '1' }, {
      changed: Object.keys(body),
    });
    return updated;
  }
}

@Global()
@Module({ providers: [SettingsService], controllers: [SettingsController], exports: [SettingsService] })
export class SettingsModule {}
