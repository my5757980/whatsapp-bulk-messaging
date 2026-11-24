// Link previews and robots (feature 005, research R3). They are redirected like anyone else but never
// counted as clicks (FR-004). User-agent matching is a weak signal, but the usual one.

export interface LinkRequest {
  method: string;
  userAgent?: string | undefined;
  /** The `Purpose` header. */
  purpose?: string | undefined;
  /** The `Sec-Purpose` header. */
  secPurpose?: string | undefined;
}

export type ClickDeviceKind = 'MOBILE' | 'DESKTOP' | 'OTHER';

/** WhatsApp's own preview fetcher (`WhatsApp/2.x.x.x A|i|W`) and other known preview fetchers and robots. */
const KNOWN_FETCHERS =
  /whatsapp\/\d|facebookexternalhit|facebot|twitterbot|slackbot|telegrambot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot/i;
/**
 * Generic robot words, either on their own or as the end of a product name before a version
 * ("AhrefsBot/7.0"). Phone models that merely contain "bot" (such as "CUBOT_X19") do not match.
 */
const GENERIC_FETCHERS = /\b(?:bot|crawler|spider|preview|scanner)\b|[a-z0-9](?:bot|crawler|spider)\/\d/i;
const MOBILE = /android|iphone|ipad|ipod|mobile|windows phone|blackberry|bb10|opera mini|iemobile|kaios/i;

export function isPreviewRequest(request: LinkRequest): boolean {
  if (request.method.toUpperCase() === 'HEAD') return true;
  if (/prefetch/i.test(request.purpose ?? '') || /prefetch/i.test(request.secPurpose ?? '')) return true;
  const userAgent = request.userAgent ?? '';
  return KNOWN_FETCHERS.test(userAgent) || GENERIC_FETCHERS.test(userAgent);
}

export function deviceKind(userAgent: string | undefined): ClickDeviceKind {
  const value = (userAgent ?? '').trim();
  if (!value) return 'OTHER';
  return MOBILE.test(value) ? 'MOBILE' : 'DESKTOP';
}
