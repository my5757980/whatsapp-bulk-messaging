import { TTL_RANGES, ttlAppliedByFor, type TemplateCategoryName, type TemplateKind } from '@wbm/shared';

// Feature 009 (T016): template kinds, time-to-live labels and who applies it.

export const KIND_LABELS: Record<TemplateKind, string> = {
  STANDARD: 'Standard',
  CAROUSEL: 'Carousel',
  LIMITED_TIME_OFFER: 'Limited-time offer',
  AUTHENTICATION: 'One-time code',
};

export const KIND_HINTS: Record<TemplateKind, string> = {
  STANDARD: 'Text, media and buttons',
  CAROUSEL: '2 to 10 cards with an image or video each (marketing)',
  LIMITED_TIME_OFFER: 'An offer with an end time and a code to copy (marketing)',
  AUTHENTICATION: 'A code your website or app sends; WhatsApp sets the wording',
};

/** "30 seconds", "15 minutes", "12 hours", "30 days". */
export function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/** The allowed range for a category, e.g. "30 seconds to 15 minutes". */
export function ttlRangeLabel(category: TemplateCategoryName): string {
  const [min, max] = TTL_RANGES[category];
  return `${durationLabel(min)} to ${durationLabel(max)}`;
}

/** Who applies a category's time-to-live, for the editor. */
export function ttlAppliedByLabel(category: TemplateCategoryName): string {
  return ttlAppliedByFor(category) === 'META' ? 'WhatsApp drops messages it cannot deliver in this time' : 'The platform stops sending messages that waited longer in its queue';
}
