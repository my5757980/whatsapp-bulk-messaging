'use client';

import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { FlowEditor } from '@/components/flows/flow-editor';
import { RequirePermission } from '@/components/require-permission';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { flowKeys, type FlowDetail } from '@/lib/flows';

/** Flow editor page (003 T027). */
export default function FlowEditorPage() {
  return (
    <RequirePermission permission="flows.manage">
      <EditorLoader />
    </RequirePermission>
  );
}

function EditorLoader() {
  const { id } = useParams<{ id: string }>();
  // Bumped after a draft conflict, so the editor starts again from the newest saved draft.
  const [generation, setGeneration] = useState(0);
  // Always loaded fresh (no cache after leaving) and never refreshed under the member's hands.
  const flow = useQuery({
    queryKey: flowKeys.detail(id),
    queryFn: () => api<FlowDetail>(`/flows/${id}`),
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (flow.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (flow.error || !flow.data) return <p className="text-sm text-destructive">{errorMessage(flow.error)}</p>;
  return (
    <ReactFlowProvider>
      <FlowEditor
        key={`${flow.data.id}:${generation}`}
        initial={flow.data}
        onReload={async () => {
          await flow.refetch();
          setGeneration((n) => n + 1);
        }}
      />
    </ReactFlowProvider>
  );
}
