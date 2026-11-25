// Ad texts, buttons and media (feature 007, FR-009, research R4): Meta's hard limits, enforced, and
// its recommended lengths, shown as hints.

import type { AdGoal, FieldProblem } from './targeting.js';

export const MAX_AD_VERSIONS = 5;
export const AD_TEXT_LIMITS = { primaryText: 2200, headline: 255, prefilledMessage: 300 } as const;
export const AD_TEXT_RECOMMENDED = { primaryText: 125, headline: 40 } as const;

export const CALL_TO_ACTIONS: Record<AdGoal, readonly string[]> = {
  CHATS: ['WHATSAPP_MESSAGE'],
  LEADS: ['SIGN_UP', 'LEARN_MORE'],
  WEBSITE: ['LEARN_MORE', 'SHOP_NOW', 'CONTACT_US'],
};

export type AdMediaKindName = 'IMAGE' | 'VIDEO';

export const AD_MEDIA_LIMITS = {
  IMAGE: { mimeTypes: ['image/jpeg', 'image/png'], maxBytes: 30 * 1024 * 1024, minWidth: 600 },
  VIDEO: { mimeTypes: ['video/mp4', 'video/quicktime'], maxBytes: 4 * 1024 * 1024 * 1024, minSeconds: 1, maxSeconds: 241 * 60 },
} as const;

export function mediaKindOf(mimeType: string): AdMediaKindName | null {
  if ((AD_MEDIA_LIMITS.IMAGE.mimeTypes as readonly string[]).includes(mimeType)) return 'IMAGE';
  if ((AD_MEDIA_LIMITS.VIDEO.mimeTypes as readonly string[]).includes(mimeType)) return 'VIDEO';
  return null;
}

export interface VersionFacts {
  primaryText: string;
  headline: string;
  callToAction: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  durationSeconds?: number | null;
}

/** Problems that block submitting a version (`field` is relative to the version). */
export function versionProblems(v: VersionFacts, goal: AdGoal): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (!v.primaryText.trim()) problems.push({ field: 'primaryText', issue: 'is needed' });
  if (v.primaryText.length > AD_TEXT_LIMITS.primaryText) problems.push({ field: 'primaryText', issue: `allows at most ${AD_TEXT_LIMITS.primaryText} characters` });
  if (!v.headline.trim()) problems.push({ field: 'headline', issue: 'is needed' });
  if (v.headline.length > AD_TEXT_LIMITS.headline) problems.push({ field: 'headline', issue: `allows at most ${AD_TEXT_LIMITS.headline} characters` });
  if (!CALL_TO_ACTIONS[goal].includes(v.callToAction)) problems.push({ field: 'callToAction', issue: `must be one of ${CALL_TO_ACTIONS[goal].join(', ')}` });
  const kind = mediaKindOf(v.mimeType);
  if (!kind) {
    problems.push({ field: 'mediaAssetId', issue: 'must be a JPG or PNG image, or an MP4 or MOV video' });
    return problems;
  }
  if (v.sizeBytes > AD_MEDIA_LIMITS[kind].maxBytes) problems.push({ field: 'mediaAssetId', issue: 'is larger than Meta allows' });
  if (kind === 'IMAGE' && v.width && v.width < AD_MEDIA_LIMITS.IMAGE.minWidth) problems.push({ field: 'mediaAssetId', issue: `must be at least ${AD_MEDIA_LIMITS.IMAGE.minWidth} pixels wide` });
  if (kind === 'VIDEO' && v.durationSeconds && (v.durationSeconds < AD_MEDIA_LIMITS.VIDEO.minSeconds || v.durationSeconds > AD_MEDIA_LIMITS.VIDEO.maxSeconds)) {
    problems.push({ field: 'mediaAssetId', issue: 'must last between 1 second and 241 minutes' });
  }
  return problems;
}

/** Texts over Meta's recommended lengths still run, but may be cut short on some placements. */
export function textHints(v: Pick<VersionFacts, 'primaryText' | 'headline'>): string[] {
  const hints: string[] = [];
  if (v.primaryText.length > AD_TEXT_RECOMMENDED.primaryText) hints.push(`Main text over ${AD_TEXT_RECOMMENDED.primaryText} characters may be cut short.`);
  if (v.headline.length > AD_TEXT_RECOMMENDED.headline) hints.push(`Headlines over ${AD_TEXT_RECOMMENDED.headline} characters may be cut short.`);
  return hints;
}
