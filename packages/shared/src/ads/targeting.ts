// Ad targeting and placements (feature 007, FR-007, FR-008, FR-011, research R5): our own shape,
// its rules, and Meta's targeting spec built from it.

export const AD_GOALS = ['CHATS', 'LEADS', 'WEBSITE'] as const;
export type AdGoal = (typeof AD_GOALS)[number];

export const AD_SPECIAL_CATEGORIES = ['NONE', 'CREDIT', 'EMPLOYMENT', 'HOUSING', 'SOCIAL_ISSUES'] as const;
export type AdSpecialCategoryName = (typeof AD_SPECIAL_CATEGORIES)[number];

export interface TargetingOption {
  key: string;
  name: string;
  /** country, region, city or interest */
  type: string;
  countryCode?: string | null;
}

export interface AdTargeting {
  locations: TargetingOption[];
  ageMin?: number;
  ageMax?: number;
  genders?: 'ALL' | 'MEN' | 'WOMEN';
  interests?: TargetingOption[];
  includeAudienceIds?: string[];
  excludeAudienceIds?: string[];
}

export interface AdPlacements {
  auto: boolean;
  facebook?: Array<'feed' | 'story'>;
  instagram?: Array<'stream' | 'story'>;
  /** WhatsApp Status: chat ads only; Meta asks for Instagram stories too (R5). */
  whatsappStatus?: boolean;
}

export interface FieldProblem {
  field: string;
  issue: string;
}

export const TARGETING_LIMITS = { locations: 50, interests: 25, audiences: 10, ageMin: 18, ageMax: 65 } as const;

/** Problems with an audience; ads in a special category may not narrow by age, gender or interests. */
export function targetingProblems(t: AdTargeting, category: AdSpecialCategoryName = 'NONE'): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const ageMin = t.ageMin ?? TARGETING_LIMITS.ageMin;
  const ageMax = t.ageMax ?? TARGETING_LIMITS.ageMax;
  if (!t.locations.length) problems.push({ field: 'targeting.locations', issue: 'needs at least one place' });
  if (t.locations.length > TARGETING_LIMITS.locations) problems.push({ field: 'targeting.locations', issue: `allows at most ${TARGETING_LIMITS.locations} places` });
  if (ageMin < TARGETING_LIMITS.ageMin || ageMax > TARGETING_LIMITS.ageMax || ageMin > ageMax) {
    problems.push({ field: 'targeting.ageMin', issue: `ages run from ${TARGETING_LIMITS.ageMin} to ${TARGETING_LIMITS.ageMax}, youngest first` });
  }
  if ((t.interests?.length ?? 0) > TARGETING_LIMITS.interests) problems.push({ field: 'targeting.interests', issue: `allows at most ${TARGETING_LIMITS.interests} interests` });
  for (const key of ['includeAudienceIds', 'excludeAudienceIds'] as const) {
    if ((t[key]?.length ?? 0) > TARGETING_LIMITS.audiences) problems.push({ field: `targeting.${key}`, issue: `allows at most ${TARGETING_LIMITS.audiences} audiences` });
  }
  if (category !== 'NONE') {
    if (ageMin !== TARGETING_LIMITS.ageMin || ageMax !== TARGETING_LIMITS.ageMax) problems.push({ field: 'targeting.ageMin', issue: 'cannot be narrowed for ads in a special category' });
    if ((t.genders ?? 'ALL') !== 'ALL') problems.push({ field: 'targeting.genders', issue: 'cannot be narrowed for ads in a special category' });
    if (t.interests?.length) problems.push({ field: 'targeting.interests', issue: 'cannot be used for ads in a special category' });
  }
  return problems;
}

/** Problems with the chosen placements. */
export function placementProblems(p: AdPlacements, goal: AdGoal): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (p.whatsappStatus && goal !== 'CHATS') problems.push({ field: 'placements.whatsappStatus', issue: 'is only for ads that start WhatsApp chats' });
  if (p.whatsappStatus && p.auto) problems.push({ field: 'placements.whatsappStatus', issue: 'needs chosen placements, not automatic ones' });
  if (!p.auto && !(p.facebook?.length || p.instagram?.length || p.whatsappStatus)) problems.push({ field: 'placements', issue: 'choose at least one place, or automatic placements' });
  return problems;
}

/** WhatsApp Status needs Instagram stories selected too (R5). */
export function normalizePlacements(p: AdPlacements): AdPlacements {
  if (p.auto) return { auto: true };
  const instagram = [...new Set(p.instagram ?? [])];
  if (p.whatsappStatus && !instagram.includes('story')) instagram.push('story');
  return { auto: false, facebook: [...new Set(p.facebook ?? [])], instagram, whatsappStatus: Boolean(p.whatsappStatus) };
}

/** Meta's targeting spec; audience ids are Meta's, resolved by the caller. */
export function metaTargeting(t: AdTargeting, placements: AdPlacements, audiences: { include: string[]; exclude: string[] } = { include: [], exclude: [] }): Record<string, unknown> {
  const of = (type: string) => t.locations.filter((l) => l.type === type);
  const geo: Record<string, unknown> = {};
  if (of('country').length) geo.countries = of('country').map((l) => l.key);
  if (of('region').length) geo.regions = of('region').map((l) => ({ key: l.key }));
  if (of('city').length) geo.cities = of('city').map((l) => ({ key: l.key }));
  const spec: Record<string, unknown> = {
    geo_locations: geo,
    age_min: t.ageMin ?? TARGETING_LIMITS.ageMin,
    age_max: t.ageMax ?? TARGETING_LIMITS.ageMax,
  };
  if (t.genders === 'MEN') spec.genders = [1];
  if (t.genders === 'WOMEN') spec.genders = [2];
  if (t.interests?.length) spec.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.key, name: i.name })) }];
  if (audiences.include.length) spec.custom_audiences = audiences.include.map((id) => ({ id }));
  if (audiences.exclude.length) spec.excluded_custom_audiences = audiences.exclude.map((id) => ({ id }));
  const p = normalizePlacements(placements);
  if (!p.auto) {
    const platforms: string[] = [];
    if (p.facebook?.length) {
      platforms.push('facebook');
      spec.facebook_positions = p.facebook;
    }
    if (p.instagram?.length) {
      platforms.push('instagram');
      spec.instagram_positions = p.instagram;
    }
    if (p.whatsappStatus) {
      platforms.push('whatsapp');
      spec.whatsapp_positions = ['status'];
    }
    spec.publisher_platforms = platforms;
  }
  return spec;
}
