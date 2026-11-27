// Carts sent in chat (feature 008 US6, FR-026, research R11): the inbound handler hands an `order`
// message to the commerce module through this port, so the inbox never imports commerce.

export interface InboundOrder {
  conversationId: string;
  contactId: string;
  numberId: string;
  chatItemId: string;
  text: string | null;
  payload: Record<string, unknown>;
}

export const CHAT_ORDERS = Symbol('CHAT_ORDERS');

export interface ChatOrdersPort {
  /** Makes the chat order (and, in automatic mode without warnings, sends its payment link). */
  received(order: InboundOrder): Promise<void>;
}
