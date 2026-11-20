import { describe, expect, it } from 'vitest';
import { FlowGraphSchema } from '../graph.js';
import { validateForPublish } from '../validate.js';
import { FLOW_STARTERS, starterByKey } from './index.js';

// 003 T078: the starter flows parse, pass the publish checks, save answers only to the attributes they
// list (with a fitting type), and are written by us.
describe('starter flows', () => {
  it('offers the six starters with unique keys', () => {
    expect(FLOW_STARTERS.map((s) => s.key)).toEqual(['faq_menu', 'lead_capture', 'appointment_request', 'order_status', 'feedback_rating', 'business_hours']);
    expect(starterByKey('lead_capture')?.name).toBe('Lead capture');
    expect(starterByKey('nope')).toBeUndefined();
  });

  it.each(FLOW_STARTERS.map((s) => [s.key, s] as const))('%s parses and passes the publish checks', (_key, starter) => {
    expect(FlowGraphSchema.safeParse(starter.graph).success).toBe(true);
    expect(validateForPublish(starter.graph)).toEqual([]);
    expect(starter.description.length).toBeGreaterThan(20);
    expect(starter.graph.triggers.length).toBeGreaterThan(0);
  });

  it.each(FLOW_STARTERS.map((s) => [s.key, s] as const))('%s saves answers only to its listed attributes, of a fitting type', (_key, starter) => {
    const listed = new Map(starter.attributes.map((a) => [a.key, a.type]));
    for (const step of starter.graph.steps) {
      if (!('saveTo' in step) || !step.saveTo) continue;
      const type = listed.get(step.saveTo.attributeKey);
      expect(type, `${step.id} saves to ${step.saveTo.attributeKey}`).toBeDefined();
      const kind = step.type === 'question' ? step.answer.kind : 'text';
      expect(type === 'TEXT' || (type === 'DATE' && kind === 'date') || (type === 'NUMBER' && kind === 'number')).toBe(true);
    }
  });

  it('uses our own wording only', () => {
    const text = JSON.stringify(FLOW_STARTERS).toLowerCase();
    for (const name of ['aisensy', 'wati', 'interakt', 'gallabox', 'respond.io']) expect(text).not.toContain(name);
  });
});
