import { describe, expect, it } from 'vitest';
import { NUMBER_GUIDES } from './number-guides.js';
import { OBA_CHECKLIST_CHECKED_AT, OBA_CHECKLIST_STEPS, OBA_STEP_IDS } from './oba-checklist.js';

// T010 (feature 010, research R12): the blue tick checklist and the number guides are complete and dated.
const META_HOSTS = ['developers.facebook.com', 'www.facebook.com', 'business.whatsapp.com', 'faq.whatsapp.com'];
const isMetaLink = (url: string) => META_HOSTS.includes(new URL(url).host);

describe('blue tick checklist', () => {
  it('gives every step a title, a body and Meta links (optional steps may have none)', () => {
    expect(new Set(OBA_STEP_IDS).size).toBe(OBA_CHECKLIST_STEPS.length);
    for (const step of OBA_CHECKLIST_STEPS) {
      expect(step.title.length, step.id).toBeGreaterThan(5);
      expect(step.body.length, step.id).toBeGreaterThan(20);
      if (!step.optional) expect(step.links.length, step.id).toBeGreaterThan(0);
      for (const link of step.links) expect(isMetaLink(link.url), link.url).toBe(true);
    }
    expect(OBA_CHECKLIST_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('covers Meta\'s eligibility list', () => {
    expect(OBA_STEP_IDS).toEqual(expect.arrayContaining(['policy', 'thirty-days', 'business-verification', 'two-step', 'display-name', 'apply']));
  });
});

describe('number guides', () => {
  it('has both guides with ordered steps, warnings, Meta links and a check date', () => {
    expect(NUMBER_GUIDES.map((g) => g.id)).toEqual(['move-here', 'move-back']);
    for (const guide of NUMBER_GUIDES) {
      expect(guide.steps.length).toBeGreaterThanOrEqual(4);
      expect(guide.steps.some((s) => s.warning)).toBe(true);
      expect(guide.links.length).toBeGreaterThan(0);
      for (const link of guide.links) expect(isMetaLink(link.url), link.url).toBe(true);
      expect(guide.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
