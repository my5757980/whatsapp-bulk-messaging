import { describe, expect, it } from 'vitest';
import { campaignStateFrom, versionStateFrom } from './statuses.js';

// T008 (feature 007, research R6): Meta's delivery states mapped to the platform's.
describe('ad states', () => {
  it("maps each ad's effective status", () => {
    expect(['PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED'].map(versionStateFrom)).toEqual(['IN_REVIEW', 'IN_REVIEW', 'IN_REVIEW']);
    expect(versionStateFrom('ACTIVE')).toBe('ACTIVE');
    expect(['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].map(versionStateFrom)).toEqual(['PAUSED', 'PAUSED', 'PAUSED']);
    expect(versionStateFrom('DISAPPROVED')).toBe('REJECTED');
    expect(['ARCHIVED', 'DELETED'].map(versionStateFrom)).toEqual(['ENDED', 'ENDED']);
    expect(versionStateFrom('WITH_ISSUES')).toBeNull();
    expect(versionStateFrom('PENDING_BILLING_INFO')).toBeNull();
  });

  it("derives the campaign's state", () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const base = { campaignStatus: 'ACTIVE', adsetStatus: 'ACTIVE', endAt: null, now };
    expect(campaignStateFrom({ ...base, versions: ['IN_REVIEW'] })).toBe('IN_REVIEW');
    expect(campaignStateFrom({ ...base, versions: ['ACTIVE', 'REJECTED'] })).toBe('ACTIVE');
    expect(campaignStateFrom({ ...base, versions: ['REJECTED', 'REJECTED'] })).toBe('REJECTED');
    expect(campaignStateFrom({ ...base, campaignStatus: 'PAUSED', versions: ['ACTIVE'] })).toBe('PAUSED');
    expect(campaignStateFrom({ ...base, adsetStatus: 'PAUSED', versions: ['ACTIVE'] })).toBe('PAUSED');
    expect(campaignStateFrom({ ...base, campaignStatus: 'WITH_ISSUES', versions: ['ACTIVE'] })).toBe('ERROR');
    expect(campaignStateFrom({ ...base, adsetStatus: 'PENDING_BILLING_INFO', versions: ['ACTIVE'] })).toBe('ERROR');
    expect(campaignStateFrom({ ...base, endAt: new Date('2026-11-24T00:00:00Z'), versions: ['ACTIVE'] })).toBe('ENDED');
    expect(campaignStateFrom({ ...base, campaignStatus: 'ARCHIVED', versions: ['ACTIVE'] })).toBe('ENDED');
    expect(campaignStateFrom({ ...base, versions: ['PAUSED', 'REJECTED'] })).toBe('PAUSED');
  });
});
