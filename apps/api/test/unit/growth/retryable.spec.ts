import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_FAILURE_REASON, RETRYABLE_CODES, retryClassOf } from '../../../src/modules/meta/meta-error-classifier.js';
import { decideSendFailure } from '../../../src/modules/sending/send-outcome.js';
import { MetaNetworkError } from '../../../src/modules/meta/meta-graph.client.js';

// T033 (feature 005, FR-014, research R4): which failed messages a retry round may send again.
describe('retryClassOf', () => {
  it('retries every failure that may pass', () => {
    expect([...RETRYABLE_CODES].sort((a, b) => a - b)).toEqual([4, 80007, 130429, 131000, 131016, 131056, 133004]);
    for (const code of RETRYABLE_CODES) expect(retryClassOf(code, 'whatever'), String(code)).toBe('RETRY');
    // An HTTP 5xx without a Meta code, or a request that never reached Meta.
    expect(retryClassOf(null, 'Service Unavailable')).toBe('RETRY');
    expect(retryClassOf(null, 'Could not reach Meta before sending')).toBe('RETRY');
  });

  it("holds back Meta's per-person marketing limit instead of retrying it within 24 hours", () => {
    expect(retryClassOf(131049, 'Not delivered to maintain healthy ecosystem engagement')).toBe('HELD_BACK');
  });

  it('never retries invalid numbers, quality limits, opt-outs, template and account errors, or unknown outcomes', () => {
    for (const code of [131026, 131048, 131050, 131047, 132000, 132001, 132007, 132012, 132015, 132016, 190, 10, 368, 133010, 100]) {
      expect(retryClassOf(code, 'x'), String(code)).toBe('NEVER');
    }
    // The request may have reached Meta: resending could deliver the message twice (001 SC-004).
    expect(retryClassOf(null, AMBIGUOUS_FAILURE_REASON)).toBe('NEVER');
  });

  it('uses the same marker as the send worker for unknown outcomes', () => {
    const decision = decideSendFailure(new MetaNetworkError('ambiguous', 'socket hang up'), 1);
    expect(decision).toMatchObject({ action: 'fail', reason: AMBIGUOUS_FAILURE_REASON });
  });
});
