import { describe, expect, it } from 'vitest';
import { metaTargeting, normalizePlacements, placementProblems, targetingProblems, type AdTargeting } from './targeting.js';

// T006 (feature 007, research R5): targeting and placement rules, and Meta's targeting spec.
const uae = { key: 'AE', name: 'United Arab Emirates', type: 'country' };
const base: AdTargeting = { locations: [uae] };

describe('ad targeting', () => {
  it('needs a place, keeps ages between 18 and 65, and limits interests and audiences', () => {
    expect(targetingProblems(base)).toEqual([]);
    expect(targetingProblems({ locations: [] })).toContainEqual({ field: 'targeting.locations', issue: 'needs at least one place' });
    expect(targetingProblems({ ...base, ageMin: 30, ageMax: 25 })[0]!.field).toBe('targeting.ageMin');
    expect(targetingProblems({ ...base, ageMin: 16 })).toHaveLength(1);
    const many = Array.from({ length: 26 }, (_, i) => ({ key: String(i), name: `I${i}`, type: 'interest' }));
    expect(targetingProblems({ ...base, interests: many })).toContainEqual({ field: 'targeting.interests', issue: 'allows at most 25 interests' });
    expect(targetingProblems({ ...base, includeAudienceIds: Array.from({ length: 11 }, (_, i) => `a${i}`) })).toHaveLength(1);
  });

  it('keeps special category ads broad', () => {
    expect(targetingProblems({ ...base, ageMin: 25 }, 'CREDIT')).toContainEqual({ field: 'targeting.ageMin', issue: 'cannot be narrowed for ads in a special category' });
    expect(targetingProblems({ ...base, genders: 'WOMEN' }, 'HOUSING')).toContainEqual({ field: 'targeting.genders', issue: 'cannot be narrowed for ads in a special category' });
    expect(targetingProblems({ ...base, interests: [{ key: '1', name: 'Loans', type: 'interest' }] }, 'EMPLOYMENT')).toHaveLength(1);
    expect(targetingProblems(base, 'SOCIAL_ISSUES')).toEqual([]);
  });

  it('offers WhatsApp Status for chat ads with chosen placements, adding Instagram stories', () => {
    expect(placementProblems({ auto: true }, 'CHATS')).toEqual([]);
    expect(placementProblems({ auto: false }, 'CHATS')).toEqual([{ field: 'placements', issue: 'choose at least one place, or automatic placements' }]);
    expect(placementProblems({ auto: false, whatsappStatus: true }, 'LEADS')[0]!.issue).toBe('is only for ads that start WhatsApp chats');
    expect(placementProblems({ auto: true, whatsappStatus: true }, 'CHATS')[0]!.issue).toBe('needs chosen placements, not automatic ones');
    expect(normalizePlacements({ auto: false, whatsappStatus: true, facebook: ['feed'] })).toEqual({ auto: false, facebook: ['feed'], instagram: ['story'], whatsappStatus: true });
  });

  it("builds Meta's targeting spec", () => {
    const spec = metaTargeting(
      {
        locations: [uae, { key: '3005', name: 'Dubai', type: 'region' }, { key: '1234', name: 'Sharjah', type: 'city' }],
        ageMin: 25,
        ageMax: 45,
        genders: 'WOMEN',
        interests: [{ key: '6003', name: 'Shoes', type: 'interest' }],
      },
      { auto: false, instagram: ['stream'], whatsappStatus: true },
      { include: ['111'], exclude: ['222'] },
    );
    expect(spec).toEqual({
      geo_locations: { countries: ['AE'], regions: [{ key: '3005' }], cities: [{ key: '1234' }] },
      age_min: 25,
      age_max: 45,
      genders: [2],
      flexible_spec: [{ interests: [{ id: '6003', name: 'Shoes' }] }],
      custom_audiences: [{ id: '111' }],
      excluded_custom_audiences: [{ id: '222' }],
      instagram_positions: ['stream', 'story'],
      whatsapp_positions: ['status'],
      publisher_platforms: ['instagram', 'whatsapp'],
    });
    expect(metaTargeting(base, { auto: true })).toEqual({ geo_locations: { countries: ['AE'] }, age_min: 18, age_max: 65 });
  });
});
