'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { STATE_LABEL, type ChatItemPage, type ConversationDetail, type ConversationSummary } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import { ChatItemView } from './chat-item-view';
import { Composer } from './composer';

/** Marks the chat read at most every 3 s while it is open and the tab is visible (R8). */
function useMarkRead(id: string, newestItemId: string | undefined) {
  const queryClient = useQueryClient();
  const last = useRef(0);
  useEffect(() => {
    if (!newestItemId || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - last.current < 3_000) return;
    last.current = now;
    void api(`/inbox/conversations/${id}/read`, { method: 'POST' })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxUnread });
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
      })
      .catch(() => undefined);
  }, [id, newestItemId, queryClient]);
}

export function ChatView({ id, meId, canMonitor }: { id: string; meId: string; canMonitor: boolean }) {
  const queryClient = useQueryClient();
  const bottom = useRef<HTMLDivElement>(null);

  const detail = useQuery({
    queryKey: queryKeys.inboxConversation(id),
    queryFn: () => api<ConversationDetail>(`/inbox/conversations/${id}`),
  });
  const timeline = useInfiniteQuery({
    queryKey: queryKeys.inboxItems(id),
    queryFn: ({ pageParam }) => api<ChatItemPage>(`/inbox/conversations/${id}/items${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });

  // Pages arrive newest first; show the oldest at the top.
  const items = useMemo(() => (timeline.data?.pages.flatMap((p) => p.items) ?? []).slice().reverse(), [timeline.data]);
  const newestId = items.at(-1)?.id;
  useMarkRead(id, newestId);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [newestId]);

  const refresh = (summary?: ConversationSummary) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
    if (summary) queryClient.setQueryData<ConversationDetail>(queryKeys.inboxConversation(id), (old) => (old ? { ...old, ...summary } : old));
  };
  const act = useMutation({
    mutationFn: (action: 'intervene' | 'resolve') => api<ConversationSummary>(`/inbox/conversations/${id}/${action}`, { method: 'POST' }),
    onSuccess: (summary) => refresh(summary),
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'That did not work; please try again');
      refresh();
    },
  });

  if (detail.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading chat…</div>;
  // A failed background refetch keeps the chat on screen; a chat that never loaded, or that the
  // member may no longer see (404, e.g. another agent took it), is unavailable.
  const lostAccess = detail.error instanceof ApiError && detail.error.status === 404;
  if (!detail.data || lostAccess) return <div className="p-6 text-sm text-muted-foreground">This chat is not available to you.</div>;
  const chat = detail.data;
  const mine = chat.state === 'INTERVENED' && chat.intervenedBy?.id === meId;
  const canClose = chat.state === 'INTERVENED' && (mine || canMonitor);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Chat">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{chat.contactName ?? chat.phone ?? 'Unknown contact'}</h2>
          <p className="text-xs text-muted-foreground">
            {chat.contactName && chat.phone ? `${chat.phone} · ` : ''}
            {chat.numberLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={chat.state === 'REQUESTING' ? 'warning' : chat.state === 'INTERVENED' ? 'default' : 'secondary'}>
            {chat.inHistory ? 'Past chat' : STATE_LABEL[chat.state]}
            {chat.state === 'INTERVENED' && chat.intervenedBy ? ` · ${mine ? 'you' : chat.intervenedBy.name}` : ''}
          </Badge>
          {chat.state !== 'INTERVENED' && (
            <Button size="sm" onClick={() => act.mutate('intervene')} disabled={act.isPending}>
              Take chat
            </Button>
          )}
          {canClose && (
            <Button size="sm" variant="outline" onClick={() => act.mutate('resolve')} disabled={act.isPending}>
              Close chat
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/30 p-4" data-testid="timeline">
        {timeline.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => void timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage}>
              {timeline.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
            </Button>
          </div>
        )}
        {items.map((item) => (
          <ChatItemView key={item.id} item={item} />
        ))}
        <div ref={bottom} />
      </div>

      <Composer chat={chat} meId={meId} />
    </section>
  );
}
