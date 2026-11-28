import { describe, expect, it } from 'vitest';
import { computeStatusUpdate, parseStatuses } from '../../src/modules/webhooks/handlers/status-update.js';

// T077: status webhook rules (FR-025, contracts/meta-webhooks.md §3).
const at = (s: number) => new Date(s * 1000);
const snapshot = (status: string, extra: Record<string, unknown> = {}) => ({
  status: status as never,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  ...extra,
});

describe('computeStatusUpdate', () => {
  it('moves forward and stamps the time', () => {
    expect(computeStatusUpdate(snapshot('SENT'), { status: 'delivered', timestamp: at(100) })).toEqual({
      status: 'DELIVERED',
      deliveredAt: at(100),
    });
  });

  it('fills timestamps for out-of-order events without downgrading the status', () => {
    expect(computeStatusUpdate(snapshot('READ', { readAt: at(200) }), { status: 'delivered', timestamp: at(150) })).toEqual({
      deliveredAt: at(150),
    });
  });

  it('ignores a duplicate event', () => {
    expect(computeStatusUpdate(snapshot('DELIVERED', { deliveredAt: at(100) }), { status: 'delivered', timestamp: at(100) })).toBeNull();
  });

  it('applies failed only below DELIVERED and keeps the error', () => {
    expect(
      computeStatusUpdate(snapshot('SENT'), { status: 'failed', timestamp: at(50), error: { code: 131026, message: 'Message undeliverable' } }),
    ).toMatchObject({ status: 'FAILED', failedAt: at(50), failureCode: 131026 });
    // FAILED after DELIVERED is ignored entirely (no status change, no failure timestamp).
    expect(computeStatusUpdate(snapshot('DELIVERED', { deliveredAt: at(10) }), { status: 'failed', timestamp: at(50) })).toBeNull();
  });

  it('stores pricing information', () => {
    expect(
      computeStatusUpdate(snapshot('SENT'), { status: 'delivered', timestamp: at(100), pricing: { billable: true, category: 'marketing' } }),
    ).toEqual({ status: 'DELIVERED', deliveredAt: at(100), billable: true, pricingCategory: 'marketing' });
  });

  it('records deleted as event only', () => {
    expect(computeStatusUpdate(snapshot('READ'), { status: 'deleted', timestamp: at(100) })).toBeNull();
  });

  it('lets a late webhook replace "not delivered in time", but never a message dropped before sending (feature 009)', () => {
    const late = snapshot('EXPIRED', { sentAt: at(10), expiredReason: 'NOT_DELIVERED_IN_TIME' });
    expect(computeStatusUpdate(late, { status: 'delivered', timestamp: at(900) })).toEqual({ expiredReason: null, status: 'DELIVERED', deliveredAt: at(900) });
    expect(computeStatusUpdate(late, { status: 'read', timestamp: at(950) })).toEqual({ expiredReason: null, status: 'READ', readAt: at(950) });
    expect(computeStatusUpdate(late, { status: 'failed', timestamp: at(960), error: { code: 131026, message: 'Message undeliverable' } })).toMatchObject({ expiredReason: null, status: 'FAILED', failureCode: 131026 });
    for (const expiredReason of ['EXPIRED_BEFORE_SENDING', 'OFFER_ENDED']) {
      expect(computeStatusUpdate(snapshot('EXPIRED', { expiredReason }), { status: 'delivered', timestamp: at(900) })).toEqual({ deliveredAt: at(900) });
      expect(computeStatusUpdate(snapshot('EXPIRED', { expiredReason }), { status: 'failed', timestamp: at(900) })).toBeNull();
    }
  });
});

describe('parseStatuses', () => {
  it('reads Meta status objects', () => {
    const parsed = parseStatuses({
      statuses: [
        { id: 'wamid.1', status: 'failed', timestamp: '1700000000', recipient_id: '971501234567', errors: [{ code: 131026, title: 'Undeliverable', message: 'Message undeliverable' }] },
        { id: 'wamid.2', status: 'read', timestamp: '1700000001', pricing: { billable: false, category: 'utility', pricing_model: 'PMP' } },
        { status: 'sent' },
      ],
    });
    expect(parsed).toEqual([
      { wamid: 'wamid.1', status: 'failed', timestamp: at(1700000000), recipientId: '971501234567', error: { code: 131026, message: 'Message undeliverable' } },
      { wamid: 'wamid.2', status: 'read', timestamp: at(1700000001), recipientId: undefined, pricing: { billable: false, category: 'utility' } },
    ]);
  });
});
