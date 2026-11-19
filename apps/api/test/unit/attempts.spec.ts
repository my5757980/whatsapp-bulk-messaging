import { describe, expect, it } from 'vitest';
import { isFinalAttempt } from '../../src/common/queue/attempts.js';

describe('isFinalAttempt', () => {
  it('is false while BullMQ still has retries left', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
  });

  it('is true on the last attempt or when the job has no retries', () => {
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });
});
