import { Role } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { decideDelivery, type InboxEventEnvelope } from '../../../src/modules/inbox/realtime/event-filter.js';
import type { AgentRuleFacts, Viewer } from '../../../src/modules/inbox/conversations/visibility.js';

// T010: which live events each user receives (contracts/realtime-events.md rules 1-2).
const admin: Viewer = { id: 'admin', role: Role.ADMIN };
const manager: Viewer = { id: 'manager', role: Role.MANAGER };
const agentA: Viewer = { id: 'agent-a', role: Role.AGENT };
const agentB: Viewer = { id: 'agent-b', role: Role.AGENT };
const noFacts = { tagIds: [], attributes: {} };

const event = (over: Partial<InboxEventEnvelope> = {}): InboxEventEnvelope => ({
  type: 'message.created',
  conversationId: 'c1',
  numberId: 'n1',
  contactId: 'k1',
  state: 'ACTIVE',
  intervenedById: null,
  blocked: false,
  at: '2026-11-19T10:00:00.000Z',
  data: { conversationId: 'c1', item: { id: 'i1', text: 'hi' } },
  ...over,
});

describe('decideDelivery', () => {
  it('sends events of open chats to agents', () => {
    expect(decideDelivery(agentA, [], noFacts, event())).toEqual({
      send: true,
      event: 'message.created',
      data: { conversationId: 'c1', item: { id: 'i1', text: 'hi' } },
    });
  });

  it('never sends agents the events of chats another agent took', () => {
    const taken = event({ state: 'INTERVENED', intervenedById: 'agent-b' });
    expect(decideDelivery(agentA, [], noFacts, taken)).toEqual({ send: false });
    expect(decideDelivery(agentB, [], noFacts, taken).send).toBe(true);
    expect(decideDelivery(admin, [], noFacts, taken).send).toBe(true);
    expect(decideDelivery(manager, [], noFacts, taken).send).toBe(true);
  });

  it('sends nothing about blocked contacts', () => {
    expect(decideDelivery(admin, [], noFacts, event({ blocked: true }))).toEqual({ send: false });
  });

  it('tells a user once when a chat leaves their view', () => {
    const takenByB = event({
      type: 'conversation.upserted',
      state: 'INTERVENED',
      intervenedById: 'agent-b',
      prev: { state: 'ACTIVE', intervenedById: null, blocked: false },
      data: { id: 'c1', state: 'INTERVENED', lastMessagePreview: 'hi' },
    });
    expect(decideDelivery(agentA, [], noFacts, takenByB)).toEqual({ send: true, event: 'conversation.upserted', data: { id: 'c1', visible: false } });
    expect(decideDelivery(agentB, [], noFacts, takenByB)).toEqual({
      send: true,
      event: 'conversation.upserted',
      data: { id: 'c1', state: 'INTERVENED', lastMessagePreview: 'hi', visible: true },
    });
  });

  it('drops the chat for everyone once its contact is blocked', () => {
    const blocked = event({ type: 'conversation.upserted', blocked: true, prev: { state: 'ACTIVE', intervenedById: null, blocked: false }, data: { id: 'c1' } });
    expect(decideDelivery(admin, [], noFacts, blocked)).toEqual({ send: true, event: 'conversation.upserted', data: { id: 'c1', visible: false } });
  });

  it('stays silent about chats a user could not see before or after', () => {
    const stillHidden = event({
      type: 'conversation.upserted',
      state: 'INTERVENED',
      intervenedById: 'agent-b',
      prev: { state: 'INTERVENED', intervenedById: 'agent-c', blocked: false },
      data: { id: 'c1' },
    });
    expect(decideDelivery(agentA, [], noFacts, stillHidden)).toEqual({ send: false });
  });

  it('masks phone numbers for agents and cuts previews to 120 characters', () => {
    const upsert = event({
      type: 'conversation.upserted',
      data: { id: 'c1', contact: { name: null, phone: '+971500001234' }, lastMessagePreview: 'x'.repeat(200) },
    });
    const forAgent = decideDelivery(agentA, [], noFacts, upsert);
    expect(forAgent).toMatchObject({ send: true, data: { contact: { phone: '•••• 1234' } } });
    expect((forAgent as { data: { lastMessagePreview: string } }).data.lastMessagePreview).toHaveLength(120);
    expect(decideDelivery(manager, [], noFacts, upsert)).toMatchObject({ send: true, data: { contact: { phone: '+971500001234' } } });
  });

  it('applies agent rules with the contact facts', () => {
    const rules: AgentRuleFacts[] = [{ kind: 'TAG', tagId: 'tag-demo', attributeKey: null, attributeValue: null }];
    expect(decideDelivery(agentA, rules, noFacts, event())).toEqual({ send: false });
    expect(decideDelivery(agentA, rules, { tagIds: ['tag-demo'], attributes: {} }, event()).send).toBe(true);
    expect(decideDelivery(agentA, rules, null, event())).toEqual({ send: false }); // contact unknown or erased
  });

  it('sends contact updates to users whose rules match the contact', () => {
    const update = event({ type: 'contact.updated', conversationId: null, state: null, data: { contactId: 'k1', conversationIds: ['c1'] } });
    const rules: AgentRuleFacts[] = [{ kind: 'ATTRIBUTE', tagId: null, attributeKey: 'city', attributeValue: 'Dubai' }];
    expect(decideDelivery(admin, [], noFacts, update).send).toBe(true);
    expect(decideDelivery(agentA, [], noFacts, update).send).toBe(true);
    expect(decideDelivery(agentA, rules, noFacts, update)).toEqual({ send: false });
    expect(decideDelivery(agentA, rules, { tagIds: [], attributes: { city: 'Dubai' } }, update).send).toBe(true);
  });

  it('always sends resync', () => {
    expect(decideDelivery(agentA, [], null, event({ type: 'resync', conversationId: null, data: {} }))).toEqual({ send: true, event: 'resync', data: {} });
  });
});
