// WhatsApp template rules (FR-018, T137), shared by the web editor and the API so both report the
// same problem next to the same field. Field names match the TemplateInput contract schema.
// Feature 009 (research R1, R2, R6 - R8): authentication, carousel and limited-time offer kinds and a
// time-to-live per template, from Meta's pages read on 2026-11-27.

export type TemplateHeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
/** CATALOG, MPM and FLOW buttons: feature 008 (contracts/meta-commerce-graph.md). */
export type TemplateButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'CATALOG' | 'MPM' | 'FLOW';
export type TemplateCategoryName = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** Feature 009: the kind decides the components (contracts/meta-templates.md §1). */
export type TemplateKind = 'STANDARD' | 'CAROUSEL' | 'LIMITED_TIME_OFFER' | 'AUTHENTICATION';
export const TEMPLATE_KINDS: readonly TemplateKind[] = ['STANDARD', 'CAROUSEL', 'LIMITED_TIME_OFFER', 'AUTHENTICATION'];

export interface TemplateButtonDraft {
  type: TemplateButtonType;
  text: string;
  url?: string;
  urlExample?: string;
  phoneNumber?: string;
  /** FLOW: the Meta flow id of a published form version. */
  flowId?: string;
}

/** Authentication options (research R2); Meta fixes the body text and translates it. */
export interface AuthTemplateOptions {
  securityNote: boolean;
  /** 1–90 minutes, shown as "This code expires in N minutes"; null leaves the footer out. */
  codeExpiryMinutes: number | null;
  button: 'COPY_CODE' | 'ONE_TAP';
  buttonText?: string;
  autofillText?: string;
  /** ONE_TAP: the company's Android apps (1–5). */
  apps?: Array<{ packageName: string; signatureHash: string }>;
}

/** One carousel card (research R6). */
export interface CarouselCardDraft {
  mediaFormat: 'IMAGE' | 'VIDEO';
  sampleMediaAssetId: string | null;
  bodyText?: string;
  bodyExamples?: string[];
  buttons: TemplateButtonDraft[];
}

/** Limited-time offer details (research R7); the URL button is in `buttons`. */
export interface OfferDraft {
  offerText: string;
  showsEndTime: boolean;
  codeExample: string;
}

export interface TemplateDraft {
  wabaId?: string;
  name: string;
  language: string;
  category: TemplateCategoryName;
  kind?: TemplateKind;
  header?: { format: TemplateHeaderFormat; text?: string; textExample?: string; mediaAssetId?: string } | null;
  body: { text: string; examples?: string[] };
  footer?: string | null;
  buttons?: TemplateButtonDraft[];
  /** Seconds; null means Meta's default and no platform drop (research R8). */
  ttlSeconds?: number | null;
  auth?: AuthTemplateOptions | null;
  cards?: CarouselCardDraft[] | null;
  offer?: OfferDraft | null;
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
  // Feature 009
  carouselCardsMin: 2,
  carouselCardsMax: 10,
  cardBodyMax: 160,
  cardButtonsMax: 2,
  offerTextMax: 16,
  offerBodyMax: 600,
  offerCodeMax: 15,
  codeExpiryMinutesMin: 1,
  codeExpiryMinutesMax: 90,
  otpAppsMax: 5,
  packageNameMax: 224,
} as const;

/**
 * Time-to-live ranges in seconds (research R8). Meta applies them to code and utility templates; the
 * Cloud API takes no marketing TTL, so the platform applies the marketing range in its own queue.
 */
export const TTL_RANGES: Readonly<Record<TemplateCategoryName, readonly [number, number]>> = {
  AUTHENTICATION: [30, 900],
  UTILITY: [30, 43_200],
  MARKETING: [43_200, 2_592_000],
};

export type TtlAppliedBy = 'META' | 'PLATFORM';

/** Who applies a template's time-to-live. */
export function ttlAppliedByFor(category: TemplateCategoryName): TtlAppliedBy {
  return category === 'MARKETING' ? 'PLATFORM' : 'META';
}

/** Whether a TTL fits the category (null always fits). */
export function ttlFits(category: TemplateCategoryName, ttlSeconds: number | null | undefined): boolean {
  if (ttlSeconds === null || ttlSeconds === undefined) return true;
  const [min, max] = TTL_RANGES[category];
  return Number.isInteger(ttlSeconds) && ttlSeconds >= min && ttlSeconds <= max;
}

/** The TTL to keep after Meta changes a template's category: unchanged when it fits, else null. */
export function ttlAfterCategoryChange(category: TemplateCategoryName, ttlSeconds: number | null | undefined): number | null {
  return ttlSeconds !== null && ttlSeconds !== undefined && ttlFits(category, ttlSeconds) ? ttlSeconds : null;
}

/** Header sample types accepted by Meta's Resumable Upload API, with our size limits. */
export const HEADER_MEDIA: Readonly<Record<Exclude<TemplateHeaderFormat, 'TEXT'>, { mimeTypes: readonly string[]; maxBytes: number }>> = {
  IMAGE: { mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
  VIDEO: { mimeTypes: ['video/mp4'], maxBytes: 16 * MB },
  DOCUMENT: { mimeTypes: ['application/pdf'], maxBytes: 100 * MB },
};

const ANY_PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SIGNATURE_HASH = /^[A-Za-z0-9+/=]{11}$/;

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

/** The kind of a draft; drafts from before 009 have none. */
export function kindOf(draft: Pick<TemplateDraft, 'kind'>): TemplateKind {
  return draft.kind ?? 'STANDARD';
}

/** Returns every problem with the draft; an empty list means it can be submitted. */
export function validateTemplate(
  draft: TemplateDraft,
  media?: { mimeType: string; sizeBytes: number } | null,
  /** Feature 009: the sample file of each carousel card, when known. */
  cardMedia?: ReadonlyArray<{ mimeType: string; sizeBytes: number } | null>,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (field: string, issue: string) => {
    if (!issues.some((i) => i.field === field)) issues.push({ field, issue });
  };
  const kind = kindOf(draft);

  if (!/^[a-z0-9_]+$/.test(draft.name) || draft.name.length > TEMPLATE_LIMITS.nameMax) {
    add('name', `use lower-case letters, numbers and underscores only (up to ${TEMPLATE_LIMITS.nameMax})`);
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2,3})?$/.test(draft.language)) add('language', 'use a language code such as en_US');
  if (draft.category === 'AUTHENTICATION' && kind !== 'AUTHENTICATION') {
    add('category', 'one-time code templates use the one-time code type, with Meta\'s fixed wording');
  }
  if (kind === 'AUTHENTICATION' && draft.category !== 'AUTHENTICATION') add('category', 'one-time code templates are authentication templates');
  if ((kind === 'CAROUSEL' || kind === 'LIMITED_TIME_OFFER') && draft.category !== 'MARKETING') {
    add('category', kind === 'CAROUSEL' ? 'carousel templates are marketing templates' : 'limited-time offer templates are marketing templates');
  }
  if (draft.ttlSeconds !== null && draft.ttlSeconds !== undefined && !ttlFits(draft.category, draft.ttlSeconds)) {
    const [min, max] = TTL_RANGES[draft.category];
    add('ttlSeconds', `for ${draft.category.toLowerCase()} templates use ${min} to ${max} seconds`);
  }

  if (kind === 'AUTHENTICATION') {
    checkAuthentication(draft, add);
    return issues;
  }

  const header = draft.header;
  if (kind === 'CAROUSEL' && header) add('header', 'a carousel has no header; each card has its own image or video');
  else if (kind === 'LIMITED_TIME_OFFER' && header && header.format !== 'IMAGE' && header.format !== 'VIDEO') add('header.format', 'an offer header is an image or a video');
  else if (header) checkHeader(header, media, add);

  const body = draft.body.text ?? '';
  const bodyMax = kind === 'LIMITED_TIME_OFFER' ? TEMPLATE_LIMITS.offerBodyMax : TEMPLATE_LIMITS.bodyMax;
  checkText(body, draft.body.examples, 'body', bodyMax, add, { required: true, filledMax: kind === 'LIMITED_TIME_OFFER' });

  if (draft.footer) {
    if (kind === 'CAROUSEL' || kind === 'LIMITED_TIME_OFFER') add('footer', kind === 'CAROUSEL' ? 'a carousel has no footer' : 'an offer has no footer');
    else if (draft.footer.length > TEMPLATE_LIMITS.footerMax) add('footer', `must be at most ${TEMPLATE_LIMITS.footerMax} characters`);
    else if (placeholderNames(draft.footer).length) add('footer', 'the footer cannot contain variables');
  }

  const buttons = draft.buttons ?? [];
  if (kind === 'CAROUSEL') {
    if (buttons.length) add('buttons', 'carousel buttons belong to the cards');
    checkCards(draft.cards ?? [], cardMedia, add);
    return issues;
  }
  if (kind === 'LIMITED_TIME_OFFER') {
    checkOffer(draft.offer, add);
    if (buttons.length !== 1 || buttons[0]?.type !== 'URL') add('buttons', 'an offer has one website button (the copy-code button is added for you)');
    else checkButton(buttons[0], 'buttons.0', add);
    return issues;
  }

  if (buttons.length > TEMPLATE_LIMITS.buttonsMax) add('buttons', `at most ${TEMPLATE_LIMITS.buttonsMax} buttons`);
  else if (buttons.filter((b) => b.type === 'URL').length > TEMPLATE_LIMITS.urlButtonsMax) add('buttons', `at most ${TEMPLATE_LIMITS.urlButtonsMax} website buttons`);
  else if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > TEMPLATE_LIMITS.phoneButtonsMax) add('buttons', 'at most one phone number button');

  // Feature 008: catalog and multi-product templates are marketing templates with that one button.
  const productButton = buttons.findIndex((b) => b.type === 'CATALOG' || b.type === 'MPM');
  if (productButton >= 0) {
    if (buttons.length !== 1) add(`buttons.${productButton}.type`, 'a catalog or product list button must be the only button');
    if (draft.category !== 'MARKETING') add('category', 'catalog and product list templates are marketing templates');
  }

  buttons.forEach((button, i) => checkButton(button, `buttons.${i}`, add));
  return issues;
}

type Add = (field: string, issue: string) => void;

function checkHeader(header: NonNullable<TemplateDraft['header']>, media: { mimeType: string; sizeBytes: number } | null | undefined, add: Add): void {
  if (header.format === 'TEXT') {
    const text = header.text ?? '';
    const names = placeholderNames(text);
    if (isBlank(text)) add('header.text', 'enter the header text');
    else if (text.length > TEMPLATE_LIMITS.headerTextMax) add('header.text', `must be at most ${TEMPLATE_LIMITS.headerTextMax} characters`);
    else if (names.length > 1 || (names.length === 1 && names[0] !== '1')) add('header.text', 'the header can have one variable, {{1}}');
    else if (names.length === 1 && isBlank(header.textExample)) add('header.textExample', 'add a sample value for {{1}}');
    return;
  }
  const rule = HEADER_MEDIA[header.format];
  if (!header.mediaAssetId) add('header.mediaAssetId', 'upload a sample file for the header');
  else if (media) {
    if (!rule.mimeTypes.includes(media.mimeType)) add('header.mediaAssetId', `use ${rule.mimeTypes.join(' or ')} for a ${header.format.toLowerCase()} header`);
    else if (media.sizeBytes > rule.maxBytes) add('header.mediaAssetId', `must be at most ${rule.maxBytes / MB} MB`);
  }
}

/** A text with numbered variables and their examples. `filledMax` counts the examples in the limit. */
function checkText(text: string, examples: readonly string[] | undefined, field: string, max: number, add: Add, opts: { required: boolean; filledMax?: boolean }): void {
  if (isBlank(text)) {
    if (opts.required) add(`${field}.text`, 'enter the message text');
    return;
  }
  const names = placeholderNames(text);
  const filled = opts.filledMax ? text.replace(ANY_PLACEHOLDER, (_m, n: string) => examples?.[Number(n) - 1] ?? '') : text;
  if (filled.length > max) {
    add(`${field}.text`, opts.filledMax ? `must be at most ${max} characters, sample values included` : `must be at most ${max} characters`);
    return;
  }
  if (!names.every((n) => /^\d+$/.test(n))) add(`${field}.text`, 'use numbered variables like {{1}}, {{2}}');
  else if (!isSequential(names)) add(`${field}.text`, 'number the variables in order from {{1}} without gaps');
  else {
    const count = new Set(names).size;
    for (let i = 0; i < count; i++) {
      if (isBlank(examples?.[i])) add(`${field}.examples.${i}`, `add a sample value for {{${i + 1}}}`);
    }
  }
}

function checkButton(button: TemplateButtonDraft, field: string, add: Add): void {
  if (isBlank(button.text)) add(`${field}.text`, 'enter the button text');
  else if (button.text.length > TEMPLATE_LIMITS.buttonTextMax) add(`${field}.text`, `must be at most ${TEMPLATE_LIMITS.buttonTextMax} characters`);

  if (button.type === 'URL') {
    const url = button.url ?? '';
    const names = placeholderNames(url);
    const concrete = url.replace(ANY_PLACEHOLDER, 'x');
    if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(concrete) || url.length > TEMPLATE_LIMITS.urlMax) add(`${field}.url`, 'enter a full link starting with https://');
    else if (names.length > 1 || (names.length === 1 && (names[0] !== '1' || !/\{\{\s*1\s*\}\}$/.test(url)))) {
      add(`${field}.url`, 'a link can have one variable, {{1}}, at the very end');
    } else if (names.length === 1 && isBlank(button.urlExample)) add(`${field}.urlExample`, 'add a sample value for the end of the link');
  }
  if (button.type === 'FLOW' && !/^[A-Za-z0-9_-]{1,64}$/.test(button.flowId ?? '')) add(`${field}.flowId`, 'choose a published form');
  if (button.type === 'PHONE_NUMBER' && !/^\+[1-9]\d{6,14}$/.test(button.phoneNumber ?? '')) {
    add(`${field}.phoneNumber`, 'use international format, e.g. +15550100000');
  }
}

function checkAuthentication(draft: TemplateDraft, add: Add): void {
  if (draft.header) add('header', 'Meta fixes the wording of code templates: no header');
  if (draft.footer) add('footer', 'the footer comes from the code validity');
  if ((draft.buttons ?? []).length) add('buttons', 'the code button comes from the code options');
  const auth = draft.auth;
  if (!auth) {
    add('auth', 'choose the code options');
    return;
  }
  const minutes = auth.codeExpiryMinutes;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < TEMPLATE_LIMITS.codeExpiryMinutesMin || minutes > TEMPLATE_LIMITS.codeExpiryMinutesMax)) {
    add('auth.codeExpiryMinutes', `use ${TEMPLATE_LIMITS.codeExpiryMinutesMin} to ${TEMPLATE_LIMITS.codeExpiryMinutesMax} minutes`);
  }
  if (auth.button !== 'COPY_CODE' && auth.button !== 'ONE_TAP') add('auth.button', 'choose a copy-code or one-tap button');
  if (auth.buttonText !== undefined && auth.buttonText.length > TEMPLATE_LIMITS.buttonTextMax) add('auth.buttonText', `must be at most ${TEMPLATE_LIMITS.buttonTextMax} characters`);
  if (auth.autofillText !== undefined && auth.autofillText.length > TEMPLATE_LIMITS.buttonTextMax) add('auth.autofillText', `must be at most ${TEMPLATE_LIMITS.buttonTextMax} characters`);
  if (auth.button === 'ONE_TAP') {
    const apps = auth.apps ?? [];
    if (apps.length < 1 || apps.length > TEMPLATE_LIMITS.otpAppsMax) add('auth.apps', `add 1 to ${TEMPLATE_LIMITS.otpAppsMax} Android apps for one-tap`);
    apps.forEach((app, i) => {
      if (!PACKAGE_NAME.test(app.packageName) || app.packageName.length > TEMPLATE_LIMITS.packageNameMax) add(`auth.apps.${i}.packageName`, 'use the app package name, e.g. com.example.app');
      if (!SIGNATURE_HASH.test(app.signatureHash)) add(`auth.apps.${i}.signatureHash`, 'the signature hash has exactly 11 characters (letters, digits, + / =)');
    });
  }
}

function checkCards(cards: readonly CarouselCardDraft[], cardMedia: ReadonlyArray<{ mimeType: string; sizeBytes: number } | null> | undefined, add: Add): void {
  if (cards.length < TEMPLATE_LIMITS.carouselCardsMin || cards.length > TEMPLATE_LIMITS.carouselCardsMax) {
    add('cards', `a carousel has ${TEMPLATE_LIMITS.carouselCardsMin} to ${TEMPLATE_LIMITS.carouselCardsMax} cards`);
    return;
  }
  const format = cards[0]?.mediaFormat;
  const withBody = cards.filter((c) => !isBlank(c.bodyText)).length;
  const layout = (card: CarouselCardDraft) => card.buttons.map((b) => b.type).join(',');
  cards.forEach((card, i) => {
    const field = `cards.${i}`;
    if (card.mediaFormat !== 'IMAGE' && card.mediaFormat !== 'VIDEO') add(`${field}.mediaFormat`, 'a card has an image or a video');
    else if (card.mediaFormat !== format) add(`${field}.mediaFormat`, 'every card uses the same kind of media');
    const file = cardMedia?.[i];
    if (!card.sampleMediaAssetId) add(`${field}.sampleMediaAssetId`, 'upload a sample file for the card');
    else if (file && (card.mediaFormat === 'IMAGE' || card.mediaFormat === 'VIDEO')) {
      const rule = HEADER_MEDIA[card.mediaFormat];
      if (!rule.mimeTypes.includes(file.mimeType)) add(`${field}.sampleMediaAssetId`, `use ${rule.mimeTypes.join(' or ')}`);
      else if (file.sizeBytes > rule.maxBytes) add(`${field}.sampleMediaAssetId`, `must be at most ${rule.maxBytes / MB} MB`);
    }
    if (withBody > 0 && withBody < cards.length && isBlank(card.bodyText)) add(`${field}.bodyText`, 'give every card a text, or none');
    else checkText(card.bodyText ?? '', card.bodyExamples, field, TEMPLATE_LIMITS.cardBodyMax, (f, issue) => add(f.replace(/\.text$/, '.bodyText').replace(/\.examples\./, '.bodyExamples.'), issue), { required: false });
    if (card.buttons.length > TEMPLATE_LIMITS.cardButtonsMax) add(`${field}.buttons`, `at most ${TEMPLATE_LIMITS.cardButtonsMax} buttons per card`);
    else if (card.buttons.some((b) => b.type !== 'QUICK_REPLY' && b.type !== 'URL' && b.type !== 'PHONE_NUMBER')) add(`${field}.buttons`, 'card buttons are quick replies, website or phone buttons');
    else if (i > 0 && layout(card) !== layout(cards[0]!)) add(`${field}.buttons`, 'every card has the same buttons in the same order');
    card.buttons.forEach((button, b) => checkButton(button, `${field}.buttons.${b}`, add));
  });
}

function checkOffer(offer: OfferDraft | null | undefined, add: Add): void {
  if (!offer) {
    add('offer', 'enter the offer details');
    return;
  }
  if (isBlank(offer.offerText)) add('offer.offerText', 'enter the offer heading');
  else if ([...offer.offerText].length > TEMPLATE_LIMITS.offerTextMax) add('offer.offerText', `must be at most ${TEMPLATE_LIMITS.offerTextMax} characters`);
  if (isBlank(offer.codeExample)) add('offer.codeExample', 'enter an example offer code');
  else if (offer.codeExample.length > TEMPLATE_LIMITS.offerCodeMax) add('offer.codeExample', `must be at most ${TEMPLATE_LIMITS.offerCodeMax} characters`);
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
