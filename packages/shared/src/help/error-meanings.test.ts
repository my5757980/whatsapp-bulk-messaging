import { describe, expect, it } from 'vitest';
import { GENERAL_ADVICE, META_ERROR_MEANINGS, PLATFORM_REASON_MEANINGS, meaningOfMetaError, meaningOfPlatformReason } from './error-meanings.js';

// T011 (feature 009, research R12): every failure reason has a meaning and an action. The api unit test
// apps/api/test/unit/meta-error-classifier.spec.ts also checks every code its classifier handles.
const HANDLED = [4, 10, 190, 368, 80007, 130429, 131000, 131016, 131026, 131047, 131048, 131049, 131056, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133004, 133010];
const ADDED = [131050, 131051, 131052, 131053, 131057];

describe('error meanings', () => {
  it('cover the codes the platform handles and the 009 additions', () => {
    for (const code of [...HANDLED, ...ADDED]) {
      const meaning = META_ERROR_MEANINGS[code];
      expect(meaning, String(code)).toBeDefined();
      expect(meaning!.title.length).toBeGreaterThan(5);
      expect(meaning!.meaning.length).toBeGreaterThan(10);
      expect(meaning!.action.length).toBeGreaterThan(5);
      expect(meaning!.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('cover the platform reasons', () => {
    for (const reason of ['unknown_outcome_not_retried', 'EXPIRED_BEFORE_SENDING', 'NOT_DELIVERED_IN_TIME', 'OFFER_ENDED', 'MEDIA_NOT_HTTPS', 'MEDIA_NOT_PUBLIC', 'MEDIA_UNREACHABLE', 'MEDIA_WRONG_TYPE', 'MEDIA_TOO_LARGE', 'MEDIA_TIMEOUT']) {
      expect(PLATFORM_REASON_MEANINGS[reason], reason).toBeDefined();
      expect(meaningOfPlatformReason(reason)?.action).toMatch(/\w/);
    }
    expect(meaningOfPlatformReason('nope')).toBeNull();
    expect(meaningOfPlatformReason(null)).toBeNull();
  });

  it('explain the per-person marketing limit and say it is not charged', () => {
    expect(meaningOfMetaError(131049).meaning).toMatch(/not charged/);
  });

  it('fall back to Meta\'s text with general advice for unknown codes', () => {
    const unknown = meaningOfMetaError(999_999, 'Something new');
    expect(unknown).toMatchObject({ known: false, title: 'Something new (code 999999)', meaning: 'Something new', action: GENERAL_ADVICE });
    expect(meaningOfMetaError(null).known).toBe(false);
    expect(meaningOfMetaError(131026).known).toBe(true);
  });
});
