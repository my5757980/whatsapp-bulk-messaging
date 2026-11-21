'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface AiState {
  id: string;
  agentId: string;
  agentName: string;
  startedBy: 'CUSTOMER' | 'FLOW';
  test: boolean;
  replies: number;
  startedAt: string;
}

export const aiStateKey = (chatId: string) => ['inbox', 'ai-state', chatId] as const;

/**
 * Above the reply box while an AI agent answers the chat (004 T056, FR-020): members see which agent
 * is talking and that replying or taking the chat stops it. `refreshKey` changes with new chat items
 * and state changes (002 live events), so the banner follows the AI conversation, as the flow
 * banner does.
 */
export function AiAgentBanner({ chatId, refreshKey }: { chatId: string; refreshKey: string }) {
  const state = useQuery({
    queryKey: [...aiStateKey(chatId), refreshKey],
    queryFn: () => api<AiState | null>(`/inbox/conversations/${chatId}/ai`),
  });
  if (!state.data) return null;
  const { agentName, replies, startedBy, test } = state.data;
  const details = [replies === 1 ? '1 reply so far' : `${replies} replies so far`, startedBy === 'FLOW' ? 'handed over by a flow' : null, test ? 'test number' : null].filter(Boolean);
  return (
    <div role="status" data-testid="ai-banner" className="border-t bg-accent/60 px-4 py-2 text-xs">
      <span className="font-medium">AI agent “{agentName}” is answering</span> ({details.join(', ')}). Replying or taking the chat stops it.
    </div>
  );
}
