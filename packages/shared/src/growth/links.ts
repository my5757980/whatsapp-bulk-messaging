// Tracked links (feature 005, research R1-R2). Pure: the api passes crypto.randomInt as the random
// source, so codes stay unguessable while this module also runs in the browser.

export const LINK_CODE_LENGTH = 10;
export const LINK_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const MAX_DESTINATION_LENGTH = 2000;
/** A campaign or a drip step tracks at most this many links (the contract's limit). */
export const MAX_TRACKED_LINKS = 5;

const LINK_CODE_PATTERN = /^[0-9A-Za-z]{10}$/;

/** A new code; `randomIndex(max)` returns a uniformly random integer in [0, max). */
export function makeLinkCode(randomIndex: (max: number) => number): string {
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) code += LINK_CODE_ALPHABET[randomIndex(LINK_CODE_ALPHABET.length)];
  return code;
}

export function isLinkCode(value: string): boolean {
  return LINK_CODE_PATTERN.test(value);
}

function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** The short link a recipient opens: `${base}/${code}`. */
export function trackedLinkUrl(base: string, code: string): string {
  return `${trimBase(base)}/${code}`;
}

/** The URL button address a template needs so that each recipient gets their own code. */
export function trackedButtonUrl(base: string): string {
  return `${trimBase(base)}/{{1}}`;
}

/** True when a template's URL button can carry per-recipient codes (research R2). */
export function isTrackedButtonUrl(buttonUrl: string, base: string | undefined): boolean {
  if (!base) return false;
  return buttonUrl.trim() === trackedButtonUrl(base);
}

export type DestinationProblem = 'INVALID_URL' | 'NOT_HTTP' | 'TOO_LONG' | 'ON_TRACKING_ADDRESS';

/**
 * Why a destination cannot be used, or null. Destinations are https or http addresses of at most
 * 2,000 characters that do not point back at the tracking address (which would loop).
 */
export function destinationProblem(destination: string, trackingBase: string | undefined): DestinationProblem | null {
  const value = destination.trim();
  if (value.length > MAX_DESTINATION_LENGTH) return 'TOO_LONG';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'INVALID_URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'NOT_HTTP';
  if (!url.hostname) return 'INVALID_URL';
  if (trackingBase && isOnTrackingAddress(url, trackingBase)) return 'ON_TRACKING_ADDRESS';
  return null;
}

function isOnTrackingAddress(url: URL, trackingBase: string): boolean {
  let base: URL;
  try {
    base = new URL(trimBase(trackingBase));
  } catch {
    return false;
  }
  if (url.host !== base.host) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  return basePath === '' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

/**
 * Adds utm_source=whatsapp, utm_medium=message and utm_campaign=<name> (FR-007). Tags the address
 * already has are kept, and so are its other query parameters and its fragment, unchanged.
 */
export function withCampaignTags(destination: string, campaignName: string): string {
  const hashAt = destination.indexOf('#');
  const base = hashAt === -1 ? destination : destination.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : destination.slice(hashAt);
  let existing: URLSearchParams;
  try {
    existing = new URL(base).searchParams;
  } catch {
    return destination;
  }
  const tags: Array<[string, string]> = [
    ['utm_source', 'whatsapp'],
    ['utm_medium', 'message'],
    ['utm_campaign', campaignName],
  ];
  const missing = tags.filter(([key]) => !existing.has(key));
  if (missing.length === 0) return destination;
  const query = missing.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const separator = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${separator}${query}${hash}`;
}
