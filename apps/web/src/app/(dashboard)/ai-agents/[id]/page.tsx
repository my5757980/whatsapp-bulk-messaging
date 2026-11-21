'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AgentEditor } from '@/components/ai/agent-editor';
import { RequirePermission } from '@/components/require-permission';
import { aiKeys, type AgentDetail } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

/** AI agent editor page (004 T045). */
export default function AgentEditorPage() {
  return (
    <RequirePermission permission="ai.manage">
      <EditorLoader />
    </RequirePermission>
  );
}

function EditorLoader() {
  const { id } = useParams<{ id: string }>();
  // Bumped after a draft conflict, so the editor starts again from the newest saved draft.
  const [generation, setGeneration] = useState(0);
  // Always loaded fresh (no cache after leaving) and never refreshed under the member's hands.
  const agent = useQuery({
    queryKey: aiKeys.agent(id),
    queryFn: () => api<AgentDetail>(`/ai-agents/${id}`),
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (agent.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (agent.error || !agent.data) return <p className="text-sm text-destructive">{errorMessage(agent.error)}</p>;
  return (
    <AgentEditor
      key={`${agent.data.id}:${generation}`}
      initial={agent.data}
      onReload={async () => {
        await agent.refetch();
        setGeneration((n) => n + 1);
      }}
    />
  );
}
