import { describe, expect, it } from 'vitest';
import { MessageStatus } from './enums.js';
import { canTransition, displayStatus, isFinalForSending, statusRank } from './status.js';

describe('message status precedence (data-model.md §5)', () => {
  // Feature 009 (research R8): EXPIRED from the queue, the sweep, and late webhooks.
  it('expires queued and sent messages, and lets late webhooks replace "not delivered in time" only', () => {
    for (const from of [MessageStatus.PENDING, MessageStatus.QUEUED, MessageStatus.SENDING, MessageStatus.SENT]) expect(canTransition(from, MessageStatus.EXPIRED)).toBe(true);
    for (const from of [MessageStatus.DELIVERED, MessageStatus.READ, MessageStatus.FAILED, MessageStatus.SKIPPED]) expect(canTransition(from, MessageStatus.EXPIRED)).toBe(false);
    for (const next of [MessageStatus.DELIVERED, MessageStatus.READ, MessageStatus.FAILED]) {
      expect(canTransition(MessageStatus.EXPIRED, next, { expiredReason: 'NOT_DELIVERED_IN_TIME' })).toBe(true);
      expect(canTransition(MessageStatus.EXPIRED, next, { expiredReason: 'EXPIRED_BEFORE_SENDING' })).toBe(false);
      expect(canTransition(MessageStatus.EXPIRED, next, { expiredReason: 'OFFER_ENDED' })).toBe(false);
      expect(canTransition(MessageStatus.EXPIRED, next)).toBe(false);
    }
    expect(canTransition(MessageStatus.EXPIRED, MessageStatus.QUEUED, { expiredReason: 'NOT_DELIVERED_IN_TIME' })).toBe(false);
    expect(canTransition(MessageStatus.EXPIRED, MessageStatus.SENT, { expiredReason: 'NOT_DELIVERED_IN_TIME' })).toBe(false);
    expect(isFinalForSending(MessageStatus.EXPIRED)).toBe(true);
    expect(displayStatus(MessageStatus.EXPIRED)).toBe('Expired');
  });

  it('ranks the delivery path in order', () => {
    const path = [
      MessageStatus.PENDING,
      MessageStatus.QUEUED,
      MessageStatus.SENDING,
      MessageStatus.SENT,
      MessageStatus.DELIVERED,
      MessageStatus.READ,
    ];
    for (let i = 1; i < path.length; i++) {
      expect(statusRank(path[i]!)).toBeGreaterThan(statusRank(path[i - 1]!));
    }
  });

  it('moves forward but never backwards', () => {
    expect(canTransition(MessageStatus.SENT, MessageStatus.DELIVERED)).toBe(true);
    expect(canTransition(MessageStatus.SENT, MessageStatus.READ)).toBe(true); // read can arrive before delivered
    expect(canTransition(MessageStatus.READ, MessageStatus.DELIVERED)).toBe(false);
    expect(canTransition(MessageStatus.DELIVERED, MessageStatus.SENT)).toBe(false);
  });

  it('ignores duplicates', () => {
    expect(canTransition(MessageStatus.DELIVERED, MessageStatus.DELIVERED)).toBe(false);
  });

  it('applies FAILED only below DELIVERED', () => {
    expect(canTransition(MessageStatus.SENT, MessageStatus.FAILED)).toBe(true);
    expect(canTransition(MessageStatus.SENDING, MessageStatus.FAILED)).toBe(true);
    expect(canTransition(MessageStatus.DELIVERED, MessageStatus.FAILED)).toBe(false);
    expect(canTransition(MessageStatus.READ, MessageStatus.FAILED)).toBe(false);
  });

  it('never leaves a final failure for a delivery status', () => {
    expect(canTransition(MessageStatus.FAILED, MessageStatus.DELIVERED)).toBe(false);
  });

  it('allows SKIPPED/CANCELLED only from PENDING or QUEUED', () => {
    expect(canTransition(MessageStatus.PENDING, MessageStatus.SKIPPED)).toBe(true);
    expect(canTransition(MessageStatus.QUEUED, MessageStatus.CANCELLED)).toBe(true);
    expect(canTransition(MessageStatus.SENT, MessageStatus.CANCELLED)).toBe(false);
    expect(canTransition(MessageStatus.SENDING, MessageStatus.SKIPPED)).toBe(false);
  });

  it('allows the pause path QUEUED -> PENDING only', () => {
    expect(canTransition(MessageStatus.QUEUED, MessageStatus.PENDING)).toBe(true);
    expect(canTransition(MessageStatus.SENT, MessageStatus.PENDING)).toBe(false);
  });

  it('knows which statuses end the sending work', () => {
    expect(isFinalForSending(MessageStatus.SENT)).toBe(true);
    expect(isFinalForSending(MessageStatus.FAILED)).toBe(true);
    expect(isFinalForSending(MessageStatus.QUEUED)).toBe(false);
    expect(isFinalForSending(MessageStatus.SENDING)).toBe(false);
  });

  it('maps internal states to the spec labels (FR-025)', () => {
    expect(displayStatus(MessageStatus.PENDING)).toBe('Queued');
    expect(displayStatus(MessageStatus.SENDING)).toBe('Queued');
    expect(displayStatus(MessageStatus.READ)).toBe('Read');
  });
});
