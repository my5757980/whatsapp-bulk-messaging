// Ports the flow engine calls in other features, provided by them so flows never import them
// (no import cycles): feature 008 payment requests.
import type { FlowOutboundMessage } from './effects.js';

/** Feature 008 US8: chat items for product, catalog and form steps, built by the commerce module. */
export const FLOW_COMMERCE = Symbol('FLOW_COMMERCE');

export type FlowCommerceMessage = Extract<FlowOutboundMessage, { type: 'products' | 'catalog' | 'form' }>;

export interface FlowCommercePort {
  /** The chat item of a commerce message, or null when it cannot be sent (no catalog, unsendable products, form not published). */
  itemFor(message: FlowCommerceMessage, ctx: { contactId: string | null; sessionId: string; numberId: string }): Promise<{ contentType: 'PRODUCT' | 'PRODUCT_LIST' | 'CATALOG' | 'FORM'; text: string | null; payload: Record<string, unknown> } | null>;
}

export const FLOW_PAYMENTS = Symbol('FLOW_PAYMENTS');

export interface FlowPaymentRequest {
  sessionId: string;
  token: number;
  conversationId: string;
  numberId: string;
  contactId: string | null;
  stepId: string;
  amount: { minor: number } | { major: number } | null;
  description: string;
  expiryMinutes: number;
  isTest: boolean;
  /** Feature 008 US8: the chat order a cart-total payment pays. */
  chatOrderId?: string | null;
}

/** Makes and sends a payment step's request; on failure the session continues on its not-paid branch. */
export interface FlowPaymentsPort {
  request(input: FlowPaymentRequest): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>;
}
