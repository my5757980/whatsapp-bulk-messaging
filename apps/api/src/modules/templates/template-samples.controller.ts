import { Body, Controller, Get, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { SAMPLE_INDUSTRIES, SAMPLE_PURPOSES, SAMPLE_TYPES, TEMPLATE_SAMPLES, extractTemplateVariables, filterSamples, kindOf, type MetaTemplateComponent, type TemplateSample } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { buildTemplateComponents, kindOptions } from './template-components.builder.js';

// Feature 009 (research R13, FR-024 - FR-026, contracts/templates-growth-api.openapi.yaml): the sample
// library from @wbm/shared. Samples are never changed or submitted directly: a copy becomes a DRAFT for
// an account, opened in the editor (which asks for any media file) and submitted from there.

const SamplesQuerySchema = z.object({
  industry: z.enum(SAMPLE_INDUSTRIES).optional(),
  purpose: z.enum(SAMPLE_PURPOSES).optional(),
  type: z.enum(SAMPLE_TYPES).optional(),
  language: z.enum(['en', 'ar']).optional(),
  search: z.string().trim().max(100).optional(),
});
type SamplesQuery = z.infer<typeof SamplesQuerySchema>;

const CopySchema = z.object({ wabaId: z.string().trim().min(1), name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'use lower-case letters, numbers and underscores only') }).strict();
type CopyInput = z.infer<typeof CopySchema>;

/** Removes `example.header_handle: [null]` left by media headers and cards without a sample file. */
function withoutMissingHandles(components: unknown[]): unknown[] {
  const clean = (part: unknown): unknown => {
    if (!part || typeof part !== 'object') return part;
    const c = { ...(part as Record<string, unknown>) };
    const example = c.example as { header_handle?: unknown[] } | undefined;
    if (example?.header_handle && example.header_handle.every((h) => h === null)) delete c.example;
    if (Array.isArray(c.cards)) c.cards = (c.cards as Array<{ components?: unknown[] }>).map((card) => ({ ...card, components: (card.components ?? []).map(clean) }));
    return c;
  };
  return components.map(clean);
}

@Injectable()
export class TemplateSamplesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(query: SamplesQuery): { items: TemplateSample[] } {
    return { items: filterSamples(query) };
  }

  get(id: string): TemplateSample {
    const sample = TEMPLATE_SAMPLES.find((s) => s.id === id);
    if (!sample) throw AppError.notFound('Sample not found');
    return sample;
  }

  async copy(id: string, input: CopyInput, actor: AuditActor & { userId: string }): Promise<{ id: string; status: 'DRAFT' }> {
    const sample = this.get(id);
    if (!(await this.prisma.whatsAppNumber.findFirst({ where: { wabaId: input.wabaId }, select: { id: true } }))) {
      throw AppError.validation('Unknown WhatsApp Business Account', [{ field: 'wabaId', issue: 'connect a number for this account first' }]);
    }
    const draft = { ...sample.draft, wabaId: input.wabaId, name: input.name };
    // No media yet: the editor asks for the header or card files before submitting. The JSON round trip
    // drops the missing sample handles, which Prisma's JSON columns refuse as undefined.
    const components = withoutMissingHandles(JSON.parse(JSON.stringify(buildTemplateComponents(draft, undefined, []))) as unknown[]);
    try {
      const template = await this.prisma.template.create({
        data: {
          wabaId: input.wabaId,
          metaTemplateId: null,
          name: input.name,
          language: draft.language,
          category: draft.category,
          parameterFormat: 'POSITIONAL',
          components: components as Prisma.InputJsonValue,
          variables: extractTemplateVariables(components as unknown as MetaTemplateComponent[]) as unknown as Prisma.InputJsonValue,
          status: 'DRAFT',
          createdById: actor.userId,
          kind: kindOf(draft),
          options: kindOptions(draft) as Prisma.InputJsonValue,
          ttlSeconds: null,
        },
      });
      await this.audit.record(actor, 'template_sample.copied', { type: 'template', id: template.id }, { sampleId: sample.id, version: sample.version });
      return { id: template.id, status: 'DRAFT' };
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A template with this name and language already exists for this account', 'NAME_TAKEN');
      throw error;
    }
  }
}

@Controller('template-samples')
export class TemplateSamplesController {
  constructor(private readonly samples: TemplateSamplesService) {}

  @Get()
  @Require('templates.view')
  list(@Query(new ZodValidationPipe(SamplesQuerySchema)) query: SamplesQuery) {
    return this.samples.list(query);
  }

  @Get(':sampleId')
  @Require('templates.view')
  get(@Param('sampleId') sampleId: string) {
    return this.samples.get(sampleId);
  }

  @Post(':sampleId/copy')
  @Require('templates.manage')
  copy(@Param('sampleId') sampleId: string, @Body(new ZodValidationPipe(CopySchema)) body: CopyInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.samples.copy(sampleId, body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
