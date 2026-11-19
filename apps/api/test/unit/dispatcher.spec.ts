import { describe, expect, it } from 'vitest';
import { planDispatch, sendJobId } from '../../src/modules/sending/dispatch-planner.js';

// T075: dispatcher decisions (research R7).
const base = { state: 'RUNNING' as const, sendingEnabled: true, connectionStatus: 'CONNECTED' as const, ratePerSecond: 20, waitingJobs: 0 };

describe('planDispatch', () => {
  it('claims at most rate x 2 messages per tick', () => {
    expect(planDispatch(base)).toEqual({ action: 'claim', batchSize: 40 });
  });

  it('only tops the buffer up to rate x 2 when jobs are still waiting', () => {
    expect(planDispatch({ ...base, waitingJobs: 30 })).toEqual({ action: 'claim', batchSize: 10 });
    expect(planDispatch({ ...base, waitingJobs: 40 })).toEqual({ action: 'wait' });
  });

  it('stops when the campaign is not RUNNING', () => {
    expect(planDispatch({ ...base, state: 'PAUSED' })).toEqual({ action: 'stop' });
    expect(planDispatch({ ...base, state: 'CANCELLED' })).toEqual({ action: 'stop' });
  });

  it('auto-pauses when the kill switch is off or the number is unavailable', () => {
    expect(planDispatch({ ...base, sendingEnabled: false })).toEqual({ action: 'pause', reason: 'sending_disabled' });
    expect(planDispatch({ ...base, connectionStatus: 'ERROR' })).toEqual({ action: 'pause', reason: 'number_unavailable' });
  });

  it('uses idempotent job ids per message', () => {
    expect(sendJobId('0190-abc')).toBe('msg-0190-abc');
  });
});
