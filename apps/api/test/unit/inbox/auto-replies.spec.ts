import { describe, expect, it } from 'vitest';
import { decideAutoReply, type AutoReplyFacts } from '../../../src/modules/inbox/automation/auto-replies.js';

// T076: which automatic message a customer message gets (FR-035, FR-036, research R10).
const facts = (over: Partial<AutoReplyFacts> = {}): AutoReplyFacts => ({
  welcomeEnabled: true,
  offHoursEnabled: true,
  withinHours: true,
  newOpening: true,
  keyword: false,
  blocked: false,
  optedOut: false,
  ...over,
});

describe('decideAutoReply', () => {
  it('welcomes a new conversation during working hours', () => {
    expect(decideAutoReply(facts())).toBe('welcome');
  });

  it('does not welcome again within the same opening', () => {
    expect(decideAutoReply(facts({ newOpening: false }))).toBeNull();
  });

  it('answers outside working hours, whether or not the conversation is new', () => {
    expect(decideAutoReply(facts({ withinHours: false }))).toBe('off_hours');
    expect(decideAutoReply(facts({ withinHours: false, newOpening: false }))).toBe('off_hours');
  });

  it('never replies to keywords, blocked contacts or opted-out contacts', () => {
    expect(decideAutoReply(facts({ keyword: true }))).toBeNull();
    expect(decideAutoReply(facts({ blocked: true }))).toBeNull();
    expect(decideAutoReply(facts({ optedOut: true }))).toBeNull();
    expect(decideAutoReply(facts({ withinHours: false, keyword: true }))).toBeNull();
  });

  it('does nothing when the messages are switched off', () => {
    expect(decideAutoReply(facts({ welcomeEnabled: false }))).toBeNull();
    expect(decideAutoReply(facts({ offHoursEnabled: false, withinHours: false }))).toBeNull();
    expect(decideAutoReply(facts({ welcomeEnabled: false, offHoursEnabled: false, withinHours: false }))).toBeNull();
  });
});
