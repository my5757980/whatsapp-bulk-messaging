import { Badge } from '@/components/ui/badge';
import type { AgentSummary } from '@/lib/ai';

/** Draft, published (with the version customers meet) or unpublished. */
export function AgentStatusBadge({ agent }: { agent: Pick<AgentSummary, 'status' | 'publishedVersion'> }) {
  if (agent.status === 'PUBLISHED') {
    return <Badge variant="success">Published{agent.publishedVersion ? ` · v${agent.publishedVersion.number}` : ''}</Badge>;
  }
  if (agent.status === 'UNPUBLISHED') return <Badge variant="secondary">Unpublished</Badge>;
  return <Badge variant="outline">Draft</Badge>;
}
