import { describe, expect, it } from 'vitest';
import { describeJourneyEntry, type JourneyEntry } from '../src/components/inbox/journey-list';

// 004 T110: the journey shows when an AI agent started and stopped answering, and the changes it made.
const entry = (type: string, data: Record<string, unknown>, actor: JourneyEntry['actor'] = { type: 'AI_AGENT', name: 'Sara' }): JourneyEntry => ({
  type,
  at: '2026-11-23T10:00:00.000Z',
  actor,
  data,
});

describe('journey entries', () => {
  it('says when an AI agent starts answering, from the customer or a flow, and in tests', () => {
    expect(describeJourneyEntry(entry('AI_STARTED', { agentName: 'Sara', startedBy: 'CUSTOMER', test: false }))).toBe('AI agent "Sara" started answering');
    expect(describeJourneyEntry(entry('AI_STARTED', { agentName: 'Sara', startedBy: 'FLOW', test: true }))).toBe('AI agent "Sara" started answering (handed over by a flow) (test)');
  });

  it('says why an AI agent stopped', () => {
    expect(describeJourneyEntry(entry('AI_ENDED', { agentName: 'Sara', result: 'HANDED_OVER' }))).toBe('AI agent "Sara" stopped: handed the chat to the team');
    expect(describeJourneyEntry(entry('AI_ENDED', { agentName: 'Sara', result: 'LIMIT_REACHED' }))).toBe('AI agent "Sara" stopped: the monthly AI reply limit was reached');
    expect(describeJourneyEntry(entry('AI_ENDED', { agentName: 'Sara', result: 'EXPIRED', test: true }))).toBe('AI agent "Sara" stopped: no customer message for 24 hours (test)');
    expect(describeJourneyEntry(entry('AI_ENDED', { agentName: 'Sara', result: 'SOMETHING_NEW' }))).toBe('AI agent "Sara" stopped: something new');
  });

  it('names the AI agent behind a change, and keeps members and flows as before', () => {
    expect(describeJourneyEntry(entry('ATTRIBUTE_CHANGED', { key: 'city', to: 'Dubai' }))).toBe('city changed to Dubai by AI agent "Sara"');
    expect(describeJourneyEntry(entry('ATTRIBUTE_CHANGED', { key: 'city', to: 'Dubai' }, { type: 'MEMBER', name: 'Omar' }))).toBe('city changed to Dubai by Omar');
    expect(describeJourneyEntry(entry('TAG_ADDED', { tag: 'vip' }, { type: 'FLOW', name: 'Welcome' }))).toBe('Tag "vip" added by Welcome');
  });

  it('names the campaign or drip whose tracked link was opened (005 FR-009)', () => {
    const customer = { type: 'CUSTOMER' as const, name: null };
    expect(describeJourneyEntry(entry('LINK_CLICKED', { campaignId: 'c1', campaignName: 'Summer Sale', dripId: null, dripName: null }, customer))).toBe(
      'Opened a link in campaign "Summer Sale"',
    );
    expect(describeJourneyEntry(entry('LINK_CLICKED', { campaignId: null, campaignName: null, dripId: 'd1', dripName: 'Welcome series' }, customer))).toBe(
      'Opened a link in drip "Welcome series"',
    );
  });

  it('says when a contact joined, left or finished a drip, and why (005 FR-033)', () => {
    const system = { type: 'SYSTEM' as const, name: null };
    expect(describeJourneyEntry(entry('DRIP_JOINED', { dripId: 'd1', dripName: 'Welcome series', via: 'MANUAL' }, system))).toBe(
      'Joined drip "Welcome series" (added by a member)',
    );
    expect(describeJourneyEntry(entry('DRIP_LEFT', { dripId: 'd1', dripName: 'Welcome series', reason: 'REPLIED' }, system))).toBe(
      'Left drip "Welcome series": wrote to the number',
    );
    expect(describeJourneyEntry(entry('DRIP_LEFT', { dripId: 'd1', dripName: 'Welcome series', reason: 'FINISHED' }, system))).toBe('Finished drip "Welcome series"');
  });
});
