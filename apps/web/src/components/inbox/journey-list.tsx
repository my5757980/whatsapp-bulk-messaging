'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface JourneyEntry {
  type: string;
  at: string;
  actor: { type: 'MEMBER' | 'CUSTOMER' | 'SYSTEM' | 'CAMPAIGN' | 'FLOW' | 'AI_AGENT' | 'API_KEY'; name: string | null };
  data: Record<string, unknown>;
}

/** Why an AI conversation ended (004 data-model §3), in our own words. */
const AI_ENDINGS: Record<string, string> = {
  HANDED_OVER: 'handed the chat to the team',
  MEMBER_TOOK: 'a member took the chat',
  CLOSED: 'the chat was closed',
  EXPIRED: 'no customer message for 24 hours',
  LIMIT_REACHED: 'the monthly AI reply limit was reached',
  FAILED: 'the AI service failed',
  OPTED_OUT: 'the customer opted out',
  BLOCKED: 'the customer was blocked',
};

/** How a contact joined a drip (feature 005), in our own words. */
const DRIP_JOINED_VIA: Record<string, string> = {
  MANUAL: 'added by a member',
  TAG_ADDED: 'a tag was added',
  OPTED_IN: 'opted in',
  IMPORTED: 'imported',
  API_CREATED: 'added by the API',
  LINK_CLICKED: 'opened a link',
};

/** Why a contact left a drip (feature 005, FR-028). */
const DRIP_LEFT_REASON: Record<string, string> = {
  REPLIED: 'wrote to the number',
  OPTED_OUT: 'opted out',
  BLOCKED: 'blocked',
  DELETED: 'contact deleted',
  STOP_TAG: 'stop tag added',
  CLICKED: 'opened a link',
  REMOVED: 'removed by a member',
  INVALID_NUMBER: 'number not on WhatsApp',
  ARCHIVED: 'drip archived',
};

/** Our own wording for journey entries (constitution Principle II). */
export function describeJourneyEntry(entry: JourneyEntry): string {
  const d = entry.data;
  // Changes the AI agent made say so, with the agent's name (004 T110); API changes name the key (006).
  const by = entry.actor.name
    ? entry.actor.type === 'AI_AGENT'
      ? ` by AI agent "${entry.actor.name}"`
      : entry.actor.type === 'API_KEY'
        ? ` by API key "${entry.actor.name}"`
        : ` by ${entry.actor.name}`
    : '';
  const agent = String(d.agentName ?? entry.actor.name ?? '');
  const test = d.test ? ' (test)' : '';
  switch (entry.type) {
    case 'REQUESTED':
      return 'Asked to talk to a person';
    case 'INTERVENED':
      return `Taken${by}`;
    case 'TRANSFERRED':
      return `Transferred${by}`;
    case 'RESOLVED':
      return `Closed${by}`;
    case 'AUTO_RESOLVED':
      return d.reason === 'owner_deactivated' ? 'Returned to Open (member deactivated)' : 'Closed after 24 hours without activity';
    case 'TAG_ADDED':
      return `Tag "${String(d.tag)}" added${by}`;
    case 'TAG_REMOVED':
      return `Tag "${String(d.tag)}" removed${by}`;
    case 'ATTRIBUTE_CHANGED':
      return `${String(d.key)} changed to ${d.to === null ? 'nothing' : String(d.to)}${by}`;
    case 'FIRST_MESSAGE_TAG_CHANGED':
      return `First-message tag set to ${d.to === null ? 'none' : String(d.to)}${by}`;
    case 'CONSENT_CHANGED':
      return `Consent: ${String(d.status).toLowerCase().replace('_', ' ')} (${String(d.source).toLowerCase()})`;
    case 'BLOCKED':
      return `Blocked${by}`;
    case 'UNBLOCKED':
      return `Unblocked${by}`;
    case 'CAMPAIGN_SENT':
      return `Campaign "${entry.actor.name ?? ''}" sent`;
    case 'API_SENT':
      return `Template "${String(d.template ?? '')}" sent by the API`;
    case 'FLOW_STARTED':
      return `Chatbot flow "${String(d.flowName ?? '')}" started${d.test ? ' (test)' : ''}`;
    case 'FLOW_ENDED':
      return `Chatbot flow "${String(d.flowName ?? '')}" ended: ${String(d.result ?? '').toLowerCase().replace(/_/g, ' ')}`;
    case 'AI_STARTED':
      return `AI agent "${agent}" started answering${d.startedBy === 'FLOW' ? ' (handed over by a flow)' : ''}${test}`;
    case 'AI_ENDED':
      return `AI agent "${agent}" stopped: ${AI_ENDINGS[String(d.result)] ?? String(d.result ?? '').toLowerCase().replace(/_/g, ' ')}${test}`;
    case 'LINK_CLICKED':
      // Feature 005 (FR-009): name the campaign or drip whose link was opened.
      return d.dripName ? `Opened a link in drip "${String(d.dripName)}"` : `Opened a link in campaign "${String(d.campaignName ?? '')}"`;
    case 'DRIP_JOINED':
      return `Joined drip "${String(d.dripName ?? '')}"${DRIP_JOINED_VIA[String(d.via)] ? ` (${DRIP_JOINED_VIA[String(d.via)]})` : ''}`;
    case 'DRIP_LEFT':
      return d.reason === 'FINISHED'
        ? `Finished drip "${String(d.dripName ?? '')}"`
        : `Left drip "${String(d.dripName ?? '')}": ${DRIP_LEFT_REASON[String(d.reason)] ?? String(d.reason ?? '').toLowerCase().replace(/_/g, ' ')}`;
    // Feature 006: store orders, COD answers and chat links.
    case 'ORDER_PLACED':
      return `Placed order ${String(d.orderNumber ?? '')} in ${String(d.store ?? 'the store')}${d.total ? ` (${String(d.total)})` : ''}`;
    case 'COD_ANSWERED':
      return d.answer === 'NO_ANSWER'
        ? `Did not answer the cash on delivery question for order ${String(d.orderNumber ?? '')}`
        : `${d.answer === 'CONFIRMED' ? 'Confirmed' : 'Cancelled'} cash on delivery order ${String(d.orderNumber ?? '')}`;
    case 'CHAT_LINK_STARTED':
      return `Started a chat from the chat link "${String(d.chatLinkName ?? '')}"${d.newContact ? ' (new contact)' : ''}`;
    // Feature 007: chats from ads and lead forms.
    case 'AD_CHAT_STARTED':
      return `Started a chat from an ad${d.adCampaignName ? ` in "${String(d.adCampaignName)}"` : d.headline ? ` ("${String(d.headline)}")` : ''}${d.newContact ? ' (new contact)' : ''}`;
    case 'LEAD_RECEIVED':
      return `Sent a lead form${d.formName ? ` "${String(d.formName)}"` : ''}${d.consent ? ' and agreed to WhatsApp messages' : ''}`;
    // Feature 008: payments, chat orders and forms.
    case 'PAYMENT_REQUESTED':
      return `Was asked to pay${d.description ? ` for "${String(d.description)}"` : ''}`;
    case 'PAYMENT_PAID':
      return d.paidLate ? 'Payment received (after the request ended)' : 'Payment received';
    case 'PAYMENT_EXPIRED':
      return 'A payment request expired unpaid';
    case 'PAYMENT_REFUNDED':
      return 'A payment was refunded';
    case 'CHAT_ORDER_RECEIVED':
      return `Sent an order in the chat${d.items ? ` (${String(d.items)} items)` : ''}`;
    case 'FORM_SUBMITTED':
      return `Filled in the form${d.formName ? ` "${String(d.formName)}"` : ''}`;
    default:
      return entry.type;
  }
}

/** The customer journey under the chat profile (T074, FR-033). */
export function JourneyList({ conversationId }: { conversationId: string }) {
  const journey = useQuery({ queryKey: ['journey', conversationId], queryFn: () => api<JourneyEntry[]>(`/inbox/conversations/${conversationId}/journey`) });
  return (
    <section className="mt-6" aria-label="Journey">
      <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Journey</h4>
      <ol className="grid gap-2 border-l pl-3" data-testid="journey">
        {journey.data?.length === 0 && <li className="text-xs text-muted-foreground">Nothing yet.</li>}
        {journey.data?.map((entry, i) => (
          <li key={`${entry.type}-${entry.at}-${i}`} className="text-xs">
            <span className="block">{describeJourneyEntry(entry)}</span>
            <span className="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
