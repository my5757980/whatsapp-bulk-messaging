// WhatsApp template rules (FR-018, T137), shared by the web editor and the API so both report the
// same problem next to the same field. Field names match the TemplateInput contract schema.

export type TemplateHeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
/** CATALOG, MPM and FLOW buttons: feature 008 (contracts/meta-commerce-graph.md). */
export type TemplateButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'CATALOG' | 'MPM' | 'FLOW';

export interface TemplateButtonDraft {
  type: TemplateButtonType;
  text: string;
  url?: string;
  urlExample?: string;
  phoneNumber?: string;
  /** FLOW: the Meta flow id of a published form version. */
  flowId?: string;
}

export interface TemplateDraft {
  wabaId?: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  header?: { format: TemplateHeaderFormat; text?: string; textExample?: string; mediaAssetId?: string } | null;
  body: { text: string; examples?: string[] };
  footer?: string | null;
  buttons?: TemplateButtonDraft[];
}

export interface TemplateIssue {
  field: string;
  issue: string;
}

const MB = 1024 * 1024;

export const TEMPLATE_LIMITS = {
  nameMax: 512,
  bodyMax: 1024,
  headerTextMax: 60,
  footerMax: 60,
  buttonTextMax: 25,
  buttonsMax: 10,
  urlButtonsMax: 2,
  phoneButtonsMax: 1,
  urlMax: 2000,
} as const;

/** Header sample types accepted by Meta's Resumable Upload API, with our size limits. */
export const HEADER_MEDIA: Readonly<Record<Exclude<TemplateHeaderFormat, 'TEXT'>, { mimeTypes: readonly string[]; maxBytes: number }>> = {
  IMAGE: { mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
  VIDEO: { mimeTypes: ['video/mp4'], maxBytes: 16 * MB },
  DOCUMENT: { mimeTypes: ['application/pdf'], maxBytes: 100 * MB },
};

const ANY_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function placeholderNames(text: string): string[] {
  return [...text.matchAll(ANY_PLACEHOLDER)].map((m) => (m[1] ?? '').trim());
}

/** Distinct body placeholder names in order of first appearance, e.g. ["1", "2"]. */
export function bodyPlaceholders(text: string): string[] {
  return [...new Set(placeholderNames(text))];
}

/** True when the names are exactly "1".."n" (each at least once). */
function isSequential(names: string[]): boolean {
  const numbers = [...new Set(names)].map(Number).sort((a, b) => a - b);
  return names.every((n) => /^\d+$/.test(n)) && numbers.every((n, i) => n === i + 1);
}

const isBlank = (value: string | undefined | null) => !value || !value.trim();

/** Returns every problem with the draft; an empty list means it can be submitted. */
export function validateTemplate(draft: TemplateDraft, media?: { mimeType: string; sizeBytes: number } | null): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (field: string, issue: string) => {
    if (!issues.some((i) => i.field === field)) issues.push({ field, issue });
  };

  if (!/^[a-z0-9_]+$/.test(draft.name) || draft.name.length > TEMPLATE_LIMITS.nameMax) {
    add('name', `use lower-case letters, numbers and underscores only (up to ${TEMPLATE_LIMITS.nameMax})`);
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2,3})?$/.test(draft.language)) add('language', 'use a language code such as en_US');
  if (draft.category === 'AUTHENTICATION') {
    add('category', 'authentication (one-time code) templates use a fixed Meta format and cannot be created in this editor');
  }

  const header = draft.header;
  if (header) {
    if (header.format === 'TEXT') {
      const text = header.text ?? '';
      const names = placeholderNames(text);
      if (isBlank(text)) add('header.text', 'enter the header text');
      else if (text.length > TEMPLATE_LIMITS.headerTextMax) add('header.text', `must be at most ${TEMPLATE_LIMITS.headerTextMax} characters`);
      else if (names.length > 1 || (names.length === 1 && names[0] !== '1')) add('header.text', 'the header can have one variable, {{1}}');
      else if (names.length === 1 && isBlank(header.textExample)) add('header.textExample', 'add a sample value for {{1}}');
    } else {
      const rule = HEADER_MEDIA[header.format];
      if (!header.mediaAssetId) add('header.mediaAssetId', 'upload a sample file for the header');
      else if (media) {
        if (!rule.mimeTypes.includes(media.mimeType)) {
          add('header.mediaAssetId', `use ${rule.mimeTypes.join(' or ')} for a ${header.format.toLowerCase()} header`);
        } else if (media.sizeBytes > rule.maxBytes) {
          add('header.mediaAssetId', `must be at most ${rule.maxBytes / MB} MB`);
        }
      }
    }
  }

  const body = draft.body.text ?? '';
  if (isBlank(body)) add('body.text', 'enter the message text');
  else if (body.length > TEMPLATE_LIMITS.bodyMax) add('body.text', `must be at most ${TEMPLATE_LIMITS.bodyMax} characters`);
  else {
    const names = placeholderNames(body);
    if (!names.every((n) => /^\d+$/.test(n))) add('body.text', 'use numbered variables like {{1}}, {{2}}');
    else if (!isSequential(names)) add('body.text', 'number the variables in order from {{1}} without gaps');
    else {
      const count = new Set(names).size;
      for (let i = 0; i < count; i++) {
        if (isBlank(draft.body.examples?.[i])) add(`body.examples.${i}`, `add a sample value for {{${i + 1}}}`);
      }
    }
  }

  if (draft.footer) {
    if (draft.footer.length > TEMPLATE_LIMITS.footerMax) add('footer', `must be at most ${TEMPLATE_LIMITS.footerMax} characters`);
    else if (placeholderNames(draft.footer).length) add('footer', 'the footer cannot contain variables');
  }

  const buttons = draft.buttons ?? [];
  if (buttons.length > TEMPLATE_LIMITS.buttonsMax) add('buttons', `at most ${TEMPLATE_LIMITS.buttonsMax} buttons`);
  else if (buttons.filter((b) => b.type === 'URL').length > TEMPLATE_LIMITS.urlButtonsMax) add('buttons', `at most ${TEMPLATE_LIMITS.urlButtonsMax} website buttons`);
  else if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > TEMPLATE_LIMITS.phoneButtonsMax) add('buttons', 'at most one phone number button');

  // Feature 008: catalog and multi-product templates are marketing templates with that one button.
  const productButton = buttons.findIndex((b) => b.type === 'CATALOG' || b.type === 'MPM');
  if (productButton >= 0) {
    if (buttons.length !== 1) add(`buttons.${productButton}.type`, 'a catalog or product list button must be the only button');
    if (draft.category !== 'MARKETING') add('category', 'catalog and product list templates are marketing templates');
  }

  buttons.forEach((button, i) => {
    if (isBlank(button.text)) add(`buttons.${i}.text`, 'enter the button text');
    else if (button.text.length > TEMPLATE_LIMITS.buttonTextMax) add(`buttons.${i}.text`, `must be at most ${TEMPLATE_LIMITS.buttonTextMax} characters`);

    if (button.type === 'URL') {
      const url = button.url ?? '';
      const names = placeholderNames(url);
      const concrete = url.replace(ANY_PLACEHOLDER, 'x');
      if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(concrete) || url.length > TEMPLATE_LIMITS.urlMax) add(`buttons.${i}.url`, 'enter a full link starting with https://');
      else if (names.length > 1 || (names.length === 1 && (names[0] !== '1' || !/\{\{\s*1\s*\}\}$/.test(url)))) {
        add(`buttons.${i}.url`, 'a link can have one variable, {{1}}, at the very end');
      } else if (names.length === 1 && isBlank(button.urlExample)) add(`buttons.${i}.urlExample`, 'add a sample value for the end of the link');
    }
    if (button.type === 'FLOW' && !/^[A-Za-z0-9_-]{1,64}$/.test(button.flowId ?? '')) add(`buttons.${i}.flowId`, 'choose a published form');
    if (button.type === 'PHONE_NUMBER' && !/^\+[1-9]\d{6,14}$/.test(button.phoneNumber ?? '')) {
      add(`buttons.${i}.phoneNumber`, 'use international format, e.g. +15550100000');
    }
  });

  return issues;
}

/**
 * Feature 008 (research R5): the index of a template's pay link button, a URL button whose link is
 * `${base}/p/{{1}}` (base = PUBLIC_LINK_BASE_URL), or -1. Payment templates need one.
 */
export function payLinkButtonIndex(buttons: readonly Pick<TemplateButtonDraft, 'type' | 'url'>[] | undefined, base: string | null | undefined): number {
  if (!base) return -1;
  const expected = `${base.replace(/\/+$/, '')}/p/{{1}}`;
  return (buttons ?? []).findIndex((b) => b.type === 'URL' && (b.url ?? '').replace(/\{\{\s*1\s*\}\}$/, '{{1}}') === expected);
}
