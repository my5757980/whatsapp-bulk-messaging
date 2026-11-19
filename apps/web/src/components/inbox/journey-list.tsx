'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface JourneyEntry {
  type: string;
  at: string;
  actor: { type: 'MEMBER' | 'CUSTOMER' | 'SYSTEM' | 'CAMPAIGN'; name: string | null };
  data: Record<string, unknown>;
}

/** Our own wording for journey entries (constitution Principle II). */
function describe(entry: JourneyEntry): string {
  const d = entry.data;
  const by = entry.actor.name ? ` by ${entry.actor.name}` : '';
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
            <span className="block">{describe(entry)}</span>
            <span className="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
