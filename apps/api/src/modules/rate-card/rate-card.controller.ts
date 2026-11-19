import { Body, Controller, Get, Injectable, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { RateCardEntry } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { RateTable, microsToUsdNumber, usdToMicros } from '../reports/cost-calculator.js';

// USD rate card (FR-029, T158): price per message category per recipient country (or "*"),
// with an effective date. Stored as integer micros.

const EntrySchema = z
  .object({
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE']),
    countryCode: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => v === '*' || /^[A-Z]{2}$/.test(v), 'use an ISO-2 country code or * for the default'),
    priceUsd: z.number().min(0).max(100),
    effectiveFrom: z.iso.date(),
  })
  .strict();
export const RateCardSchema = z.array(EntrySchema).max(2000);
export type RateCardInput = z.infer<typeof RateCardSchema>;

const toDto = (e: RateCardEntry) => ({
  category: e.category,
  countryCode: e.countryCode,
  priceUsd: microsToUsdNumber(e.priceUsdMicros),
  effectiveFrom: e.effectiveFrom.toISOString().slice(0, 10),
});

const CACHE_MS = 30_000;

@Injectable()
export class RateCardService {
  private cache: { table: RateTable; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.rateCardEntry.findMany({ orderBy: [{ category: 'asc' }, { countryCode: 'asc' }, { effectiveFrom: 'desc' }] });
    return rows.map(toDto);
  }

  /** Rate lookup table, cached briefly because status webhooks use it for every delivery. */
  async table(): Promise<RateTable> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.table;
    const rows = await this.prisma.rateCardEntry.findMany();
    const table = new RateTable(rows);
    this.cache = { table, at: Date.now() };
    return table;
  }

  /** PUT /rate-card replaces every entry atomically. */
  async replace(entries: RateCardInput, actor: AuditActor) {
    const seen = new Set<string>();
    const errors: ErrorDetail[] = [];
    entries.forEach((e, i) => {
      const key = `${e.category}|${e.countryCode}|${e.effectiveFrom}`;
      if (seen.has(key)) errors.push({ field: `${i}`, issue: 'duplicates another entry with the same category, country and date' });
      seen.add(key);
    });
    if (errors.length) throw AppError.validation('Each category, country and date can only appear once', errors);

    await this.prisma.$transaction([
      this.prisma.rateCardEntry.deleteMany({}),
      this.prisma.rateCardEntry.createMany({
        data: entries.map((e) => ({ category: e.category, countryCode: e.countryCode, priceUsdMicros: usdToMicros(e.priceUsd), effectiveFrom: new Date(`${e.effectiveFrom}T00:00:00Z`) })),
      }),
    ]);
    this.cache = null;
    await this.audit.record(actor, 'rate_card.updated', { type: 'rate_card' }, { entries: entries.length });
    return this.list();
  }
}

@Controller('rate-card')
export class RateCardController {
  constructor(private readonly rateCard: RateCardService) {}

  @Get()
  @Require('campaigns.view')
  list() {
    return this.rateCard.list();
  }

  @Put()
  @Require('ratecard.manage')
  replace(@Body(new ZodValidationPipe(RateCardSchema)) body: RateCardInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.rateCard.replace(body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
