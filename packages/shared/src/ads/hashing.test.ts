import { describe, expect, it } from 'vitest';
import { normalizePhoneForHash } from './hashing.js';
import { CALL_TO_ACTIONS, mediaKindOf, textHints, versionProblems } from './limits.js';

// T010 (feature 007, research R4, R8): phone normalization for customer lists, and version limits.
describe('customer list phone numbers', () => {
  it('keeps digits with the country code, without a plus sign or leading zeros', () => {
    expect(normalizePhoneForHash('+971501234567')).toBe('971501234567');
    expect(normalizePhoneForHash('+1 (650) 555-1212')).toBe('16505551212');
    expect(normalizePhoneForHash('00971501234567')).toBe('971501234567');
    expect(normalizePhoneForHash('+12')).toBeNull();
    expect(normalizePhoneForHash(null)).toBeNull();
  });
});

describe('ad version limits', () => {
  const image = { primaryText: 'Spring sale', headline: '30% off', callToAction: 'WHATSAPP_MESSAGE', mimeType: 'image/jpeg', sizeBytes: 200_000, width: 1080 };

  it('enforces texts, buttons per goal and media', () => {
    expect(versionProblems(image, 'CHATS')).toEqual([]);
    expect(versionProblems({ ...image, callToAction: 'SHOP_NOW' }, 'CHATS')).toEqual([{ field: 'callToAction', issue: 'must be one of WHATSAPP_MESSAGE' }]);
    expect(versionProblems({ ...image, callToAction: 'SHOP_NOW' }, 'WEBSITE')).toEqual([]);
    expect(versionProblems({ ...image, primaryText: 'x'.repeat(2201) }, 'CHATS')[0]!.field).toBe('primaryText');
    expect(versionProblems({ ...image, headline: '' }, 'CHATS')).toContainEqual({ field: 'headline', issue: 'is needed' });
    expect(versionProblems({ ...image, width: 400 }, 'CHATS')).toContainEqual({ field: 'mediaAssetId', issue: 'must be at least 600 pixels wide' });
    expect(versionProblems({ ...image, mimeType: 'image/gif' }, 'CHATS')).toContainEqual({ field: 'mediaAssetId', issue: 'must be a JPG or PNG image, or an MP4 or MOV video' });
    expect(versionProblems({ ...image, mimeType: 'video/mp4', durationSeconds: 0.5 }, 'CHATS')).toContainEqual({ field: 'mediaAssetId', issue: 'must last between 1 second and 241 minutes' });
    expect(mediaKindOf('video/quicktime')).toBe('VIDEO');
    expect(CALL_TO_ACTIONS.LEADS).toEqual(['SIGN_UP', 'LEARN_MORE']);
  });

  it("hints when texts pass Meta's recommended lengths", () => {
    expect(textHints({ primaryText: 'x'.repeat(126), headline: 'y'.repeat(41) })).toHaveLength(2);
    expect(textHints({ primaryText: 'short', headline: 'short' })).toEqual([]);
  });
});
