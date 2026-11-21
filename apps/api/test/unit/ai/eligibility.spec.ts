import type { AgentReply } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { capReached, handOverFor, handOverNote, ineligibility, type EligibilityFacts } from '../../../src/modules/ai/turns/decisions.js';

// 004 T047: who the agent may answer (FR-016) and when it hands over (FR-023, research R12).
const open: EligibilityFacts = { state: 'ACTIVE', blocked: false, optedOut: false, windowLive: true, flowRunning: false };

const reply = (fields: Partial<AgentReply> = {}): AgentReply => ({
  message: 'Hello',
  language: 'en',
  buttons: null,
  list: null,
  mediaId: null,
  usedSources: [],
  unanswered: null,
  handOver: null,
  remember: null,
  startFlow: null,
  optOut: null,
  ...fields,
});

describe('AI eligibility (FR-016)', () => {
  it('answers Open chats of contacts who may be messaged, inside the window, without a running flow', () => {
    expect(ineligibility(open)).toBeNull();
  });

  it('refuses chats waiting for an agent or taken by a member', () => {
    expect(ineligibility({ ...open, state: 'REQUESTING' })).toBe('NOT_OPEN');
    expect(ineligibility({ ...open, state: 'INTERVENED' })).toBe('NOT_OPEN');
  });

  it('refuses blocked and opted-out contacts, a closed window and a running flow', () => {
    expect(ineligibility({ ...open, blocked: true })).toBe('BLOCKED');
    expect(ineligibility({ ...open, optedOut: true })).toBe('OPTED_OUT');
    expect(ineligibility({ ...open, windowLive: false })).toBe('WINDOW_CLOSED');
    expect(ineligibility({ ...open, flowRunning: true })).toBe('FLOW_RUNNING');
  });

  it('puts blocking and opt-out first, whatever the chat state', () => {
    expect(ineligibility({ ...open, state: 'INTERVENED', blocked: true })).toBe('BLOCKED');
    expect(ineligibility({ ...open, windowLive: false, optedOut: true })).toBe('OPTED_OUT');
  });
});

describe('AI hand-over decisions (FR-023)', () => {
  const rules = { whenUnsure: 'say_so' as const, unansweredBefore: 0, capReached: false };

  it('follows the hand-over the model asked for', () => {
    expect(handOverFor(reply({ handOver: { reason: 'customer_asked', summary: 'Wants a person about an order' } }), rules)).toEqual({
      reason: 'customer_asked',
      summary: 'Wants a person about an order',
      forced: false,
    });
    expect(handOverFor(reply({ handOver: { reason: 'topic', summary: 'Refund request' } }), rules)?.reason).toBe('topic');
  });

  it('keeps answering when nothing calls for a person', () => {
    expect(handOverFor(reply(), rules)).toBeNull();
  });

  it('says so and offers a person by default when it cannot answer, and hands over when the agent is set to', () => {
    const unsure = reply({ unanswered: 'Price of the XL sofa' });
    expect(handOverFor(unsure, rules)).toBeNull();
    expect(handOverFor(unsure, { ...rules, whenUnsure: 'hand_over' })).toEqual({ reason: 'unsure', summary: 'Could not answer: Price of the XL sofa', forced: true });
  });

  it('hands over on a second question it cannot answer in the same AI conversation', () => {
    expect(handOverFor(reply({ unanswered: 'Delivery to Oman' }), { ...rules, unansweredBefore: 1 })).toEqual({
      reason: 'repeat',
      summary: 'Could not answer again: Delivery to Oman',
      forced: true,
    });
  });

  it('hands over once the reply cap is reached', () => {
    expect(capReached(19, 20)).toBe(false);
    expect(capReached(20, 20)).toBe(true);
    expect(handOverFor(reply(), { ...rules, capReached: true })).toEqual({ reason: 'cap', summary: '', forced: true });
  });

  it('never hands over an opt-out, which sends nothing', () => {
    expect(handOverFor(reply({ message: '', optOut: 'clear', handOver: { reason: 'other', summary: 'x' } }), { ...rules, capReached: true })).toBeNull();
  });

  it('writes a note with the reason and the summary for the team', () => {
    expect(handOverNote('Sara', { reason: 'customer_asked', summary: 'Wants to change an order.', forced: false })).toBe(
      'Sara handed this chat over. The customer asked for a person.\nWants to change an order.',
    );
    expect(handOverNote('Sara', { reason: 'cap', summary: '', forced: true })).toBe('Sara handed this chat over. The conversation reached the reply limit.');
  });
});
