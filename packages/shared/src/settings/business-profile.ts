// Feature 010 (research R11, FR-031, contracts/meta-business-profile.md): the WhatsApp Business profile
// limits Meta documents, checked before anything is sent. Checked against Meta's pages on 2026-11-28.

export const BUSINESS_PROFILE_LIMITS = {
  about: { min: 1, max: 139 },
  address: { max: 256 },
  description: { max: 512 },
  email: { max: 128 },
  websites: { count: 2, max: 256 },
} as const;

/** Meta's business categories (`vertical`); an empty string clears it. */
export const BUSINESS_VERTICALS = [
  'ALCOHOL',
  'APPAREL',
  'AUTO',
  'BEAUTY',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GOVT',
  'GROCERY',
  'HEALTH',
  'HOTEL',
  'NONPROFIT',
  'ONLINE_GAMBLING',
  'OTC_DRUGS',
  'OTHER',
  'PHYSICAL_GAMBLING',
  'PROF_SERVICES',
  'RESTAURANT',
  'RETAIL',
  'TRAVEL',
] as const;
export type BusinessVertical = (typeof BUSINESS_VERTICALS)[number];

/**
 * Our guard for profile pictures: Meta's API pages give no exact limit (192 px is WhatsApp's own advice),
 * so this is confirmed on the real account before release.
 */
export const PROFILE_PICTURE_RULES = { types: ['image/jpeg', 'image/png'], minSide: 192, maxBytes: 5 * 1024 * 1024 } as const;

export interface BusinessProfileInput {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: string;
}

export interface FieldIssue {
  field: string;
  issue: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBSITE = /^https?:\/\/\S+$/;

/** Field problems for a profile change; an empty list means it can be sent to Meta. */
export function checkBusinessProfile(input: BusinessProfileInput): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const L = BUSINESS_PROFILE_LIMITS;
  if (input.about !== undefined) {
    const n = input.about.trim().length;
    if (n < L.about.min) issues.push({ field: 'about', issue: 'must not be empty' });
    else if (n > L.about.max) issues.push({ field: 'about', issue: `must be at most ${L.about.max} characters` });
  }
  if (input.address !== undefined && input.address.length > L.address.max) issues.push({ field: 'address', issue: `must be at most ${L.address.max} characters` });
  if (input.description !== undefined && input.description.length > L.description.max) issues.push({ field: 'description', issue: `must be at most ${L.description.max} characters` });
  if (input.email !== undefined && input.email !== '') {
    if (input.email.length > L.email.max) issues.push({ field: 'email', issue: `must be at most ${L.email.max} characters` });
    else if (!EMAIL.test(input.email)) issues.push({ field: 'email', issue: 'must be a valid email address' });
  }
  if (input.websites !== undefined) {
    if (input.websites.length > L.websites.count) issues.push({ field: 'websites', issue: `at most ${L.websites.count} websites` });
    input.websites.forEach((url, i) => {
      if (url.length > L.websites.max) issues.push({ field: `websites.${i}`, issue: `must be at most ${L.websites.max} characters` });
      else if (!WEBSITE.test(url)) issues.push({ field: `websites.${i}`, issue: 'must start with http:// or https://' });
    });
  }
  if (input.vertical !== undefined && input.vertical !== '' && !(BUSINESS_VERTICALS as readonly string[]).includes(input.vertical)) {
    issues.push({ field: 'vertical', issue: 'is not one of Meta\'s categories' });
  }
  return issues;
}

/** Problems with a picture before upload, from its type, size in bytes and pixel size. */
export function checkProfilePicture(file: { type: string; bytes: number; width: number; height: number }): FieldIssue[] {
  const R = PROFILE_PICTURE_RULES;
  const issues: FieldIssue[] = [];
  if (!(R.types as readonly string[]).includes(file.type)) issues.push({ field: 'file', issue: 'must be a JPEG or PNG image' });
  if (file.bytes > R.maxBytes) issues.push({ field: 'file', issue: 'must be 5 MB or smaller' });
  if (file.width !== file.height) issues.push({ field: 'file', issue: 'must be square' });
  if (Math.min(file.width, file.height) < R.minSide) issues.push({ field: 'file', issue: `must be at least ${R.minSide}×${R.minSide} pixels` });
  return issues;
}
