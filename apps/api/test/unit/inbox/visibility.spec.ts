import { describe, expect, it } from 'vitest';
import {
  attributeText,
  canAccess,
  canSeeLive,
  matchesRules,
  seesAll,
  visibleSql,
} from '../../../src/modules/inbox/conversations/visibility.js';
import { admin, agentA, chat, manager, rules, TAG_DEMO, VISIBILITY_CASES } from '../../support/inbox-visibility-cases.js';

// T008: who may see which chat (FR-026-FR-028, research R7). The SQL predicate is checked against
// the same table of cases on a real database in test/integration/inbox-visibility.int-spec.ts.

describe('canAccess', () => {
  it.each(VISIBILITY_CASES)('%s', (_label, viewer, viewerRules, facts, expected) => {
    expect(canAccess(viewer, viewerRules, facts)).toBe(expected);
  });

  it('ignores agent rules for admins and managers', () => {
    expect(canAccess(admin, rules, chat())).toBe(true);
    expect(canAccess(manager, rules, chat())).toBe(true);
  });
});

describe('live lists', () => {
  it('hide blocked contacts from everyone', () => {
    expect(canSeeLive(admin, [], chat({ blocked: true }))).toBe(false);
    expect(canSeeLive(agentA, [], chat({ blocked: true }))).toBe(false);
    expect(canAccess(admin, [], chat({ blocked: true }))).toBe(true); // still reachable from History search
  });
});

describe('helpers', () => {
  it('only admins and managers see every chat', () => {
    expect(seesAll(admin)).toBe(true);
    expect(seesAll(manager)).toBe(true);
    expect(seesAll(agentA)).toBe(false);
  });

  it('an agent without rules is unrestricted', () => {
    expect(matchesRules([], chat())).toBe(true);
  });

  it('renders attribute values like Postgres ->>', () => {
    expect(attributeText('Dubai')).toBe('Dubai');
    expect(attributeText(2)).toBe('2');
    expect(attributeText(2.5)).toBe('2.5');
    expect(attributeText(true)).toBe('true');
    expect(attributeText(null)).toBeNull();
    expect(attributeText(undefined)).toBeNull();
  });
});

describe('visibleSql', () => {
  const aliases = { conversation: 'c', contact: 'k' };

  it('adds no condition for admins and managers', () => {
    expect(visibleSql(admin, rules, aliases).sql.trim()).toBe('TRUE');
    expect(visibleSql(manager, [], aliases).sql.trim()).toBe('TRUE');
  });

  it('limits agents to open and waiting chats plus their own', () => {
    const fragment = visibleSql(agentA, [], aliases);
    expect(fragment.sql).toContain('c.state IN');
    expect(fragment.sql).toContain('c.intervened_by_id =');
    expect(fragment.values).toContain(agentA.id);
  });

  it('passes every rule value as a bound parameter, never as SQL text', () => {
    const hostile = { kind: 'ATTRIBUTE' as const, tagId: null, attributeKey: "x'); DROP TABLE contacts;--", attributeValue: "' OR '1'='1" };
    const fragment = visibleSql(agentA, [...rules, hostile], aliases);
    expect(fragment.sql).not.toContain('Dubai');
    expect(fragment.sql).not.toContain('DROP TABLE');
    expect(fragment.sql).not.toContain("'1'='1");
    expect(fragment.values).toEqual(expect.arrayContaining([agentA.id, 'city', 'Dubai', 'tier', '2', [TAG_DEMO]]));
    expect(fragment.sql).toContain('k.attributes ->>');
  });
});
