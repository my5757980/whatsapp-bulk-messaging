'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ChatItem, ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import { TemplateSender } from './template-sender';

export const MAX_REPLY_LENGTH = 4096;

/** "5h 12m" until the 24-hour window closes; refreshed every 30 s. */
function useTimeLeft(windowEndsAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!windowEndsAt) return null;
  const ms = new Date(windowEndsAt).getTime() - now;
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Reply box (T036): text up to 4096 characters (emoji from the system picker). The queued
 * message shows at once; ticks follow from live events. A failed send keeps the draft.
 */
export function Composer({
  chat,
  meId,
  onSent,
}: {
  chat: ConversationDetail;
  meId: string;
  onSent?: (item: ChatItem) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const timeLeft = useTimeLeft(chat.windowEndsAt);

  const send = useMutation({
    mutationFn: (text: string) =>
      api<ChatItem>(`/inbox/conversations/${chat.id}/messages`, {
        method: 'POST',
        json: { type: 'text', text },
      }),
    onSuccess: (item) => {
      setDraft('');
      onSent?.(item);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(chat.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The reply could not be sent');
      if (error instanceof ApiError && error.code === 'WINDOW_CLOSED')
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(chat.id) });
    },
  });

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    send.mutate(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  // Templates work in Past chats too; a chat another member took stays theirs.
  const mayAct = chat.state !== 'INTERVENED' || chat.intervenedBy?.id === meId;
  if (chat.inHistory) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/40 p-4 text-sm text-muted-foreground"
        data-testid="window-closed"
      >
        <span>
          🔒 The 24-hour reply window has closed. Free replies are locked until the customer writes
          again; a template can restart the conversation.
        </span>
        {mayAct && <TemplateSender chat={chat} />}
      </div>
    );
  }
  if (!chat.canReply) {
    return (
      <div className="border-t bg-muted/40 p-4 text-sm text-muted-foreground">
        {chat.state === 'INTERVENED' && chat.intervenedBy
          ? `${chat.intervenedBy.name} has taken this chat.`
          : 'You cannot reply in this chat right now.'}
      </div>
    );
  }

  return (
    <form
      className="grid gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="Reply"
        className="min-h-[72px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"
        maxLength={MAX_REPLY_LENGTH}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{timeLeft ? `Reply window closes in ${timeLeft}` : 'Reply window closing'}</span>
        <span className="flex items-center gap-3">
          <span>
            {draft.length}/{MAX_REPLY_LENGTH}
          </span>
          <TemplateSender chat={chat} variant="outline" />
          <Button type="submit" size="sm" disabled={!draft.trim() || send.isPending}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </span>
      </div>
    </form>
  );
}
