// WhatsApp Form answers (feature 008 US7, FR-034, research R12): the inbound handler hands an
// nfm_reply to the commerce module through this port, so the inbox never imports commerce.

export interface InboundFormReply {
  conversationId: string;
  contactId: string;
  chatItemId: string;
  payload: Record<string, unknown>;
}

export const FORM_ANSWERS = Symbol('FORM_ANSWERS');

export interface FormAnswersPort {
  /** Saves the answer when its token is ours and names this contact; false leaves a plain FORM_REPLY. */
  received(reply: InboundFormReply): Promise<boolean>;
}
