import { HttpStatus } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import type { ConsentStatus, Template } from '../../generated/prisma/client.js';
import { headerMediaType } from './template-payload.builder.js';

// Rules shared by every template send outside campaigns: the public API (001) and templates sent
// from a live chat (002 T040). Errors use the contract codes and answer 422.

export const refuse = (code: string, message: string, details?: ErrorDetail[]) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);

/** Key of resolved params holding a media library asset for the header (chat templates). */
export const HEADER_MEDIA_ASSET_PARAM = '$headerMediaAssetId';

export function assertTemplateApproved(template: Pick<Template, 'status'>): void {
  if (template.status !== 'APPROVED') throw refuse('TEMPLATE_NOT_APPROVED', `The template is ${template.status.toLowerCase()}, not approved`);
}

/** Missing or unknown variables, and a missing file for a media header. */
export function templateParamProblems(
  template: Pick<Template, 'variables' | 'components'>,
  params: Record<string, string>,
  hasHeaderMedia: boolean,
  headerField = 'headerMediaUrl',
): ErrorDetail[] {
  const keys = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
  const details: ErrorDetail[] = [
    ...keys.filter((k) => !params[k]?.trim()).map((k) => ({ field: `params.${k}`, issue: 'is required' })),
    ...Object.keys(params)
      .filter((k) => !keys.includes(k))
      .map((k) => ({ field: `params.${k}`, issue: 'is not a variable of this template' })),
  ];
  const mediaType = headerMediaType(template.components as unknown as MetaTemplateComponent[]);
  if (mediaType && !hasHeaderMedia) details.push({ field: headerField, issue: `is required for a ${mediaType} header` });
  return details;
}

export function assertTemplateParams(template: Pick<Template, 'variables' | 'components'>, params: Record<string, string>, hasHeaderMedia: boolean, headerField?: string): void {
  const details = templateParamProblems(template, params, hasHeaderMedia, headerField);
  if (details.length) throw refuse('PARAMS_MISMATCH', 'The parameters do not match the template', details);
}

/** Never to opted-out contacts; marketing templates need an opt-in (001 FR-012, 002 FR-017). */
export function assertConsent(consent: ConsentStatus, category: Template['category']): void {
  if (consent === 'OPTED_OUT') throw refuse('CONTACT_OPTED_OUT', 'The contact has opted out');
  if (category === 'MARKETING' && consent !== 'OPTED_IN') throw refuse('NO_OPT_IN', 'Marketing templates need the contact to have opted in');
}
