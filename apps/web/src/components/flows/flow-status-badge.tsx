import { Badge } from '@/components/ui/badge';
import type { FlowSummary } from '@/lib/flows';

/** Draft, published (with the version customers meet) or unpublished. */
export function FlowStatusBadge({ flow }: { flow: Pick<FlowSummary, 'status' | 'publishedVersion'> }) {
  if (flow.status === 'PUBLISHED') {
    return <Badge variant="success">Published{flow.publishedVersion ? ` · v${flow.publishedVersion.number}` : ''}</Badge>;
  }
  if (flow.status === 'UNPUBLISHED') return <Badge variant="secondary">Unpublished</Badge>;
  return <Badge variant="outline">Draft</Badge>;
}
