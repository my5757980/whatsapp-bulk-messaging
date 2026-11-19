import { Role } from '@wbm/shared';
import type { AgentRuleFacts, ChatFacts, Viewer } from '../../src/modules/inbox/conversations/visibility.js';

// Shared table of visibility cases (FR-026-FR-028): the unit test checks the in-memory rule and
// the integration test checks the SQL predicate against the same rows.
export const admin: Viewer = { id: '00000000-0000-7000-8000-0000000000a1', role: Role.ADMIN };
export const manager: Viewer = { id: '00000000-0000-7000-8000-0000000000a2', role: Role.MANAGER };
export const agentA: Viewer = { id: '00000000-0000-7000-8000-0000000000a3', role: Role.AGENT };
export const AGENT_B_ID = '00000000-0000-7000-8000-0000000000a4';

export const TAG_DEMO = '00000000-0000-7000-8000-00000000d001';
export const TAG_VIP = '00000000-0000-7000-8000-00000000d002';

export const rules: AgentRuleFacts[] = [
  { kind: 'TAG', tagId: TAG_DEMO, attributeKey: null, attributeValue: null },
  { kind: 'ATTRIBUTE', tagId: null, attributeKey: 'city', attributeValue: 'Dubai' },
  { kind: 'ATTRIBUTE', tagId: null, attributeKey: 'tier', attributeValue: '2' },
];

export const chat = (over: Partial<ChatFacts> = {}): ChatFacts => ({
  state: 'ACTIVE',
  intervenedById: null,
  blocked: false,
  contactTagIds: [],
  contactAttributes: {},
  ...over,
});

export const VISIBILITY_CASES: Array<[label: string, viewer: Viewer, rules: AgentRuleFacts[], facts: ChatFacts, expected: boolean]> = [
  ['admins see chats taken by others', admin, [], chat({ state: 'INTERVENED', intervenedById: AGENT_B_ID }), true],
  ['managers see chats taken by others', manager, [], chat({ state: 'INTERVENED', intervenedById: AGENT_B_ID }), true],
  ['agents see open chats', agentA, [], chat(), true],
  ['agents see chats waiting for an agent', agentA, [], chat({ state: 'REQUESTING' }), true],
  ['agents see their own taken chats', agentA, [], chat({ state: 'INTERVENED', intervenedById: agentA.id }), true],
  ['agents never see chats taken by others', agentA, [], chat({ state: 'INTERVENED', intervenedById: AGENT_B_ID }), false],
  ['a rule-limited agent does not see unmatched chats', agentA, rules, chat(), false],
  ['a tag rule matches', agentA, rules, chat({ contactTagIds: [TAG_VIP, TAG_DEMO] }), true],
  ['another tag does not match', agentA, rules, chat({ contactTagIds: [TAG_VIP] }), false],
  ['an attribute rule matches', agentA, rules, chat({ contactAttributes: { city: 'Dubai' } }), true],
  ['attribute values are compared exactly', agentA, rules, chat({ contactAttributes: { city: 'dubai' } }), false],
  ['numbers are compared as text', agentA, rules, chat({ contactAttributes: { tier: 2 } }), true],
  ['a missing attribute does not match', agentA, rules, chat({ contactAttributes: { tier: null } }), false],
  ['own taken chats stay visible without a rule match', agentA, rules, chat({ state: 'INTERVENED', intervenedById: agentA.id }), true],
  [
    'a rule match never reveals chats taken by others',
    agentA,
    rules,
    chat({ state: 'INTERVENED', intervenedById: AGENT_B_ID, contactTagIds: [TAG_DEMO] }),
    false,
  ],
];
