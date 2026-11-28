import { describe, expect, it } from 'vitest';
import { BUSINESS_VERTICALS, checkBusinessProfile, checkProfilePicture } from './business-profile.js';

// T009 (feature 010, research R11): business profile limits.
describe('checkBusinessProfile', () => {
  it('accepts values within Meta\'s limits', () => {
    expect(
      checkBusinessProfile({ about: 'Lamps and lights', address: 'Dubai', description: 'x'.repeat(512), email: 'hello@lamps.ae', websites: ['https://lamps.ae', 'http://shop.lamps.ae'], vertical: 'RETAIL' }),
    ).toEqual([]);
    expect(checkBusinessProfile({ vertical: '' })).toEqual([]);
    expect(BUSINESS_VERTICALS).toContain('PROF_SERVICES');
  });

  it('names each field beyond the limits', () => {
    const issues = checkBusinessProfile({ about: ' ', address: 'a'.repeat(257), description: 'd'.repeat(513), email: 'not-an-email', websites: ['lamps.ae', 'https://a', 'https://b'], vertical: 'SHOES' });
    expect(issues.map((i) => i.field)).toEqual(['about', 'address', 'description', 'email', 'websites', 'websites.0', 'vertical']);
    expect(checkBusinessProfile({ about: 'a'.repeat(140) })[0]?.field).toBe('about');
  });
});

describe('checkProfilePicture', () => {
  it('needs a square JPEG or PNG of at least 192 px and at most 5 MB', () => {
    expect(checkProfilePicture({ type: 'image/png', bytes: 200_000, width: 640, height: 640 })).toEqual([]);
    expect(checkProfilePicture({ type: 'image/jpeg', bytes: 900_000, width: 3000, height: 2000 }).map((i) => i.issue)).toEqual(['must be square']);
    expect(checkProfilePicture({ type: 'image/gif', bytes: 6 * 1024 * 1024, width: 100, height: 100 })).toHaveLength(3);
  });
});
