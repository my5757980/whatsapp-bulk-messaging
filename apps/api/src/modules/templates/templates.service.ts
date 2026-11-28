import { Injectable } from '@nestjs/common';
import { extractTemplateVariables, kindOf, metaCreateProblem, ttlAppliedByFor, validateTemplate, type MetaTemplateComponent } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { MediaAsset, Prisma, Template } from '../../generated/prisma/client.js';
import { MetaResumableUpload } from '../media/meta-resumable-upload.js';
import { describeMetaError } from '../meta/meta-error-classifier.js';
import { MetaApiError, MetaGraphClient } from '../meta/meta-graph.client.js';
import { NumbersService } from '../numbers/numbers.service.js';
import { buildTemplateComponents, kindOptions, templateToDraft } from './template-components.builder.js';
import { mapTemplateCategory, mapTemplateStatus, toTemplateDto } from './templates-sync.service.js';

// Template authoring (FR-017, FR-018, T140): create and submit, duplicate, delete.

const ButtonSchema = z
  .object({
    type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
    text: z.string(),
    url: z.string().optional(),
    urlExample: z.string().optional(),
    phoneNumber: z.string().optional(),
  })
  .strict();

/** Shape of the contract `TemplateInput`; content rules come from the shared validateTemplate. */
export const TemplateInputSchema = z
  .object({
    wabaId: z.string().trim().min(1),
    name: z.string(),
    language: z.string(),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
    header: z
      .object({
        format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
        text: z.string().optional(),
        textExample: z.string().optional(),
        mediaAssetId: z.uuid().optional(),
      })
      .strict()
      .nullish(),
    body: z.object({ text: z.string(), examples: z.array(z.string()).optional() }).strict(),
    footer: z.string().nullish(),
    buttons: z.array(ButtonSchema).max(20).optional(),
    // Feature 009 (research R1, R2, R6 - R8); the shared validateTemplate checks the rules.
    kind: z.enum(['STANDARD', 'CAROUSEL', 'LIMITED_TIME_OFFER', 'AUTHENTICATION']).optional(),
    ttlSeconds: z.number().int().nullish(),
    auth: z
      .object({
        securityNote: z.boolean(),
        codeExpiryMinutes: z.number().int().nullable(),
        button: z.enum(['COPY_CODE', 'ONE_TAP']),
        buttonText: z.string().optional(),
        autofillText: z.string().optional(),
        apps: z.array(z.object({ packageName: z.string(), signatureHash: z.string() }).strict()).max(10).optional(),
      })
      .strict()
      .nullish(),
    cards: z
      .array(
        z
          .object({
            mediaFormat: z.enum(['IMAGE', 'VIDEO']),
            sampleMediaAssetId: z.uuid().nullable(),
            bodyText: z.string().optional(),
            bodyExamples: z.array(z.string()).optional(),
            buttons: z.array(ButtonSchema).max(5),
          })
          .strict(),
      )
      .max(20)
      .nullish(),
    offer: z.object({ offerText: z.string(), showsEndTime: z.boolean(), codeExample: z.string() }).strict().nullish(),
  })
  .strict();
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

function metaReason(error: unknown): string {
  return error instanceof MetaApiError ? describeMetaError(error.code, error.message) : 'Could not reach Meta';
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly numbers: NumbersService,
    private readonly resumable: MetaResumableUpload,
  ) {}

  private async getRow(id: string): Promise<Template> {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw AppError.notFound('Template not found');
    return template;
  }

  /** A connected number of the account; its token authorises template calls. */
  private async accountToken(wabaId: string, field = 'wabaId'): Promise<string> {
    const number = await this.prisma.whatsAppNumber.findFirst({ where: { wabaId, connectionStatus: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
    if (!number) {
      throw AppError.validation('No connected number for this WhatsApp Business Account', [{ field, issue: 'connect a number for this account first' }]);
    }
    return this.numbers.token(number);
  }

  async create(input: TemplateInput, userId: string) {
    const needsMedia = Boolean(input.header && input.header.format !== 'TEXT' && input.header.mediaAssetId);
    let media: MediaAsset | null = null;
    if (needsMedia) {
      media = await this.prisma.mediaAsset.findUnique({ where: { id: input.header?.mediaAssetId as string } });
      if (!media) throw AppError.validation('The template has problems', [{ field: 'header.mediaAssetId', issue: 'media not found; upload it again' }]);
    }
    // Carousel cards each have a sample file (feature 009, research R6).
    const cardIds = (input.cards ?? []).map((c) => c.sampleMediaAssetId).filter((id): id is string => Boolean(id));
    const cardAssets = cardIds.length ? await this.prisma.mediaAsset.findMany({ where: { id: { in: cardIds } } }) : [];
    const cardMedia = (input.cards ?? []).map((c) => {
      const asset = cardAssets.find((a) => a.id === c.sampleMediaAssetId);
      return asset ? { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes } : null;
    });
    const issues = validateTemplate(input, media ? { mimeType: media.mimeType, sizeBytes: media.sizeBytes } : null, cardMedia);
    (input.cards ?? []).forEach((c, i) => {
      if (c.sampleMediaAssetId && !cardMedia[i]) issues.push({ field: `cards.${i}.sampleMediaAssetId`, issue: 'media not found; upload it again' });
    });
    if (issues.length) throw AppError.validation('The template has problems', issues);

    const token = await this.accountToken(input.wabaId);
    const key = { wabaId_name_language: { wabaId: input.wabaId, name: input.name, language: input.language } };
    // A local draft with this name (004 US9) is what is being submitted now; any other row is a clash.
    const existing = await this.prisma.template.findUnique({ where: key, select: { id: true, status: true, metaTemplateId: true } });
    const draft = existing?.status === 'DRAFT' && !existing.metaTemplateId ? existing : null;
    if (existing && !draft) {
      throw AppError.conflict('A template with this name and language already exists for this account');
    }

    const headerHandle = media ? await this.resumable.uploadHeaderSample(media, token) : undefined;
    const cardHandles: string[] = [];
    for (const card of input.cards ?? []) {
      const asset = cardAssets.find((a) => a.id === card.sampleMediaAssetId);
      if (asset) cardHandles.push(await this.resumable.uploadHeaderSample(asset, token));
    }
    const components = buildTemplateComponents(input, headerHandle, cardHandles);
    // Meta applies the TTL of code and utility templates; marketing TTL is applied by our queue (R8).
    const ttl = input.ttlSeconds ?? null;
    const metaTtl = ttl !== null && ttlAppliedByFor(input.category) === 'META' ? { message_send_ttl_seconds: ttl } : {};
    const body = { name: input.name, language: input.language, category: input.category, parameter_format: 'POSITIONAL' as const, components, ...metaTtl };
    // Our own mapping is checked against Meta's rules before Meta sees it (contracts/meta-templates.md).
    const metaProblem = metaCreateProblem(body);
    if (metaProblem) throw AppError.validation(`The template does not fit Meta's rules: ${metaProblem}`, undefined, 'META_RULES');
    let result: { id: string; status: string; category: string };
    try {
      result = await this.meta.createTemplate(token, input.wabaId, body);
    } catch (error) {
      throw AppError.validation(`Meta rejected the template: ${metaReason(error)}`, undefined, 'META_ERROR');
    }

    try {
      const data = {
        wabaId: input.wabaId,
        metaTemplateId: result.id,
        name: input.name,
        language: input.language,
        category: mapTemplateCategory(result.category || input.category),
        parameterFormat: 'POSITIONAL' as const,
        components: components as Prisma.InputJsonValue,
        variables: extractTemplateVariables(components as unknown as MetaTemplateComponent[]) as unknown as Prisma.InputJsonValue,
        status: mapTemplateStatus(result.status || 'PENDING'),
        headerMediaAssetId: media?.id ?? null,
        createdById: userId,
        lastSyncedAt: new Date(),
        kind: kindOf(input),
        options: kindOptions(input) as Prisma.InputJsonValue,
        ttlSeconds: ttl,
        ttlAppliedBy: ttl === null ? null : ttlAppliedByFor(input.category),
      };
      const template = draft ? await this.prisma.template.update({ where: { id: draft.id }, data }) : await this.prisma.template.create({ data });
      return toTemplateDto(template);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A template with this name and language already exists for this account');
      throw error;
    }
  }

  /**
   * A local draft (004 US9, FR-043): checked like a new template but not submitted to Meta. It opens
   * in the template editor ("Duplicate & edit" prefill); submitting it there replaces this row.
   * Drafts have a text header or none, so no media sample is uploaded.
   */
  async saveDraft(input: TemplateInput, userId: string) {
    if (input.header && input.header.format !== 'TEXT') {
      throw AppError.validation('The template has problems', [{ field: 'header.format', issue: 'drafts can only have a text header' }]);
    }
    const issues = validateTemplate(input, null);
    if (issues.length) throw AppError.validation('The template has problems', issues);
    if (!(await this.prisma.whatsAppNumber.findFirst({ where: { wabaId: input.wabaId }, select: { id: true } }))) {
      throw AppError.validation('Unknown WhatsApp Business Account', [{ field: 'wabaId', issue: 'connect a number for this account first' }]);
    }
    const components = buildTemplateComponents(input, undefined);
    try {
      const template = await this.prisma.template.create({
        data: {
          wabaId: input.wabaId,
          metaTemplateId: null,
          name: input.name,
          language: input.language,
          category: input.category,
          parameterFormat: 'POSITIONAL',
          components: components as Prisma.InputJsonValue,
          variables: extractTemplateVariables(components as unknown as MetaTemplateComponent[]) as unknown as Prisma.InputJsonValue,
          status: 'DRAFT',
          createdById: userId,
        },
      });
      return toTemplateDto(template);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('A template with this name and language already exists for this account');
      throw error;
    }
  }

  /** POST /templates/{id}/duplicate: an editable draft copy (not saved). */
  async duplicate(id: string) {
    return templateToDraft(await this.getRow(id));
  }

  /** Deletes the template in Meta (this language only) and marks it DELETED locally. */
  async remove(id: string): Promise<void> {
    const template = await this.getRow(id);
    const inUse = await this.prisma.campaign.count({ where: { templateId: id, state: { in: ['SCHEDULED', 'RUNNING', 'PAUSED'] } } });
    if (inUse) throw AppError.conflict('This template is used by a scheduled, running or paused campaign');
    if (template.status === 'DELETED') return;

    if (template.metaTemplateId) {
      const token = await this.accountToken(template.wabaId);
      try {
        await this.meta.deleteTemplate(token, template.wabaId, template.name, template.metaTemplateId);
      } catch (error) {
        const alreadyGone = error instanceof MetaApiError && error.httpStatus === 404;
        if (!alreadyGone) throw AppError.validation(`Meta could not delete the template: ${metaReason(error)}`, undefined, 'META_ERROR');
      }
    }
    await this.prisma.template.update({ where: { id }, data: { status: 'DELETED' } });
  }
}
