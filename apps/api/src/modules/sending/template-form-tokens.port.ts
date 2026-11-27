// Templates with a form (FLOW) button (feature 008 US7, research R12): the send processor asks the
// commerce module for the recipient's signed form token through this port (sending never imports commerce).

export const TEMPLATE_FORM_TOKENS = Symbol('TEMPLATE_FORM_TOKENS');

export interface TemplateFormTokensPort {
  /** The flow_token for this message's form button, or null when the Meta flow is not one of our forms. */
  forMessage(messageId: string, contactId: string, metaFlowId: string): Promise<string | null>;
}
