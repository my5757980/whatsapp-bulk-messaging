import { describe, expect, it } from 'vitest';
import { MetaApiError, MetaNetworkError } from '../../src/modules/meta/meta-graph.client.js';
import { MAX_SEND_ATTEMPTS, backoffDelay, decideSendFailure, preSendCheck } from '../../src/modules/sending/send-outcome.js';

// T076: send processor decisions (research R7/R9). The DB shell is covered by integration tests.
describe('preSendCheck', () => {
  const ok = { messageStatus: 'QUEUED' as const, campaignState: 'RUNNING' as const, sendingEnabled: true, consent: 'OPTED_IN' as const, marketing: true };

  it('sends a queued message of a running campaign', () => {
    expect(preSendCheck(ok)).toEqual({ action: 'send' });
  });

  it('ignores messages that are no longer queued (idempotent jobs)', () => {
    expect(preSendCheck({ ...ok, messageStatus: 'SENT' })).toEqual({ action: 'ignore' });
  });

  it('returns messages of paused campaigns to PENDING and cancels for cancelled ones', () => {
    expect(preSendCheck({ ...ok, campaignState: 'PAUSED' })).toEqual({ action: 'requeue' });
    expect(preSendCheck({ ...ok, campaignState: 'CANCELLED' })).toEqual({ action: 'cancel' });
  });

  it('honours the kill switch by requeueing and pausing the campaign', () => {
    expect(preSendCheck({ ...ok, sendingEnabled: false })).toEqual({ action: 'requeue', pauseReason: 'sending_disabled' });
  });

  it('skips contacts that opted out or lack opt-in for marketing', () => {
    expect(preSendCheck({ ...ok, consent: 'OPTED_OUT' })).toEqual({ action: 'skip', reason: 'OPTED_OUT' });
    expect(preSendCheck({ ...ok, consent: 'UNKNOWN' })).toEqual({ action: 'skip', reason: 'NO_OPT_IN' });
    expect(preSendCheck({ ...ok, consent: 'UNKNOWN', marketing: false })).toEqual({ action: 'send' });
  });

  it('sends API-origin messages without campaign checks', () => {
    expect(preSendCheck({ ...ok, campaignState: null })).toEqual({ action: 'send' });
  });
});

describe('decideSendFailure', () => {
  it('retries transient Meta errors until the last attempt, then fails', () => {
    const error = new MetaApiError(429, 130429, undefined, 'throughput');
    expect(decideSendFailure(error, 1)).toMatchObject({ action: 'retry' });
    expect(decideSendFailure(error, MAX_SEND_ATTEMPTS)).toMatchObject({ action: 'fail', code: 130429 });
  });

  it('fails permanent errors immediately with a readable reason', () => {
    const decision = decideSendFailure(new MetaApiError(400, 131026, undefined, 'undeliverable'), 1);
    expect(decision).toMatchObject({ action: 'fail', code: 131026 });
    expect(decision.action === 'fail' && decision.reason).toMatch(/undeliverable/i);
  });

  it('pauses the campaign on blocking errors and returns the message to PENDING', () => {
    expect(decideSendFailure(new MetaApiError(401, 190, undefined, 'token'), 1)).toMatchObject({ action: 'block', pauseReason: 'meta_error_190' });
  });

  it('retries pre-send network errors but never ambiguous ones', () => {
    expect(decideSendFailure(new MetaNetworkError('pre_send', 'refused'), 1)).toMatchObject({ action: 'retry' });
    expect(decideSendFailure(new MetaNetworkError('ambiguous', 'timeout'), 1)).toEqual({ action: 'fail', code: null, reason: 'unknown_outcome_not_retried' });
  });

  it('treats unexpected errors as permanent failures', () => {
    expect(decideSendFailure(new Error('boom'), 1)).toMatchObject({ action: 'fail', code: null });
  });
});

describe('backoffDelay', () => {
  it('waits 30 s, 2 min, then 8 min', () => {
    expect([1, 2, 3].map(backoffDelay)).toEqual([30_000, 120_000, 480_000]);
  });
});
