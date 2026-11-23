import { describe, expect, it } from 'vitest';
import { FLOW_STARTERS } from '../../flows/starters/index.js';
import { agentConfigProblems, AgentConfigSchema, AI_LIMITS } from '../config.js';
import { AGENT_STARTERS, agentStarterByKey, agentStarterConfig } from './index.js';

// 004 T091: the starter agents parse, have nothing that blocks publishing except the example answers
// (which the server marks "replace me"), suggest valid attributes for what they remember, and are
// written by us.
const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

describe('starter agents', () => {
  it('offers the four starters with unique keys', () => {
    expect(AGENT_STARTERS.map((s) => s.key)).toEqual(['sales_enquiries', 'customer_support', 'booking_requests', 'lead_qualification']);
    expect(AGENT_STARTERS.map((s) => s.name)).toEqual(['Sales enquiries', 'Customer support', 'Booking requests', 'Lead qualification']);
    expect(agentStarterByKey('lead_qualification')?.name).toBe('Lead qualification');
    expect(agentStarterByKey('nope')).toBeUndefined();
  });

  it.each(AGENT_STARTERS.map((s) => [s.key, s] as const))('%s gives a complete draft with the agent name', (_key, starter) => {
    const config = agentStarterConfig(starter, '  Front desk  ');
    expect(AgentConfigSchema.safeParse(config).success).toBe(true);
    expect(config.displayName).toBe('Front desk');
    expect(agentConfigProblems(config)).toEqual([]);
    expect(config.goal.length).toBeGreaterThan(50);
    expect(config.guardrails.length).toBeGreaterThanOrEqual(3);
    expect(config.handOverTopics.length).toBeGreaterThanOrEqual(3);
    expect(starter.description.length).toBeGreaterThan(30);
    // A long display name is cut to the limit, an empty one falls back to ours.
    expect(agentStarterConfig(starter, 'x'.repeat(60)).displayName).toHaveLength(AI_LIMITS.displayName);
    expect(agentStarterConfig(starter, '   ').displayName).toBe('Assistant');
  });

  it.each(AGENT_STARTERS.map((s) => [s.key, s] as const))('%s has example answers with something to replace', (_key, starter) => {
    expect(starter.exampleAnswers.length).toBeGreaterThanOrEqual(2);
    const questions = new Set<string>();
    for (const example of starter.exampleAnswers) {
      expect(example.question.length).toBeLessThanOrEqual(AI_LIMITS.questionLength);
      expect(example.answer.length).toBeLessThanOrEqual(AI_LIMITS.answerLength);
      // The parts to replace are in square brackets, so nobody mistakes them for real details.
      expect(example.answer, example.question).toMatch(/\[[^\]]+\]/);
      expect(questions.has(example.question)).toBe(false);
      questions.add(example.question);
    }
  });

  it.each(AGENT_STARTERS.map((s) => [s.key, s] as const))('%s suggests a valid attribute for everything it remembers', (_key, starter) => {
    const config = agentStarterConfig(starter, 'Assistant');
    expect(starter.attributes.length).toBeGreaterThan(0);
    expect(new Set(starter.attributes.map((a) => a.key)).size).toBe(starter.attributes.length);
    for (const attribute of starter.attributes) {
      expect(attribute.key).toMatch(ATTRIBUTE_KEY);
      expect(attribute.label.length).toBeGreaterThan(0);
      expect(attribute.label.length).toBeLessThanOrEqual(60);
      expect(['TEXT', 'NUMBER', 'DATE', 'BOOLEAN']).toContain(attribute.type);
    }
    expect(config.skills.memory.map((m) => m.key)).toEqual(starter.attributes.map((a) => a.key));
  });

  it('gives the same type to an attribute key wherever starters (agents or flows) share it', () => {
    const types = new Map<string, string>();
    for (const attribute of [...AGENT_STARTERS.flatMap((s) => s.attributes), ...FLOW_STARTERS.flatMap((s) => s.attributes)]) {
      expect(types.get(attribute.key) ?? attribute.type, attribute.key).toBe(attribute.type);
      types.set(attribute.key, attribute.type);
    }
  });

  it('uses our own wording only', () => {
    const text = JSON.stringify(AGENT_STARTERS).toLowerCase();
    for (const name of ['aisensy', 'wati', 'interakt', 'gallabox', 'respond.io']) expect(text).not.toContain(name);
  });
});
