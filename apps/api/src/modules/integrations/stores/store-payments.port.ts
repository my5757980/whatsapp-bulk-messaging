import type { StoreOrderFacts } from '@wbm/shared';
import type { StoreConnection, StoreOrder } from '../../../generated/prisma/client.js';

// Pay links for store orders (feature 008 US3, FR-011, research R5): the store events processor asks
// the payments module through this port, so stores never import payments (as flows and campaigns).

export interface StorePayLinkInput {
  store: StoreConnection;
  order: StoreOrder;
  facts: StoreOrderFacts;
  phone: { e164: string; country: string } | null;
  contact: { id: string; name: string | null; consentStatus: string; blockedAt: Date | null } | null;
}

export const STORE_PAYMENTS = Symbol('STORE_PAYMENTS');

export interface StorePaymentsPort {
  /** Sends the order's Pay now link once, when the PAY_LINK automation is on and the order can be paid; records why not otherwise. */
  payLink(input: StorePayLinkInput): Promise<void>;
}
