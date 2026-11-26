// Ports the flow engine calls in other features, provided by them so flows never import them
// (no import cycles): feature 008 payment requests.

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
}

/** Makes and sends a payment step's request; on failure the session continues on its not-paid branch. */
export interface FlowPaymentsPort {
  request(input: FlowPaymentRequest): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>;
}
