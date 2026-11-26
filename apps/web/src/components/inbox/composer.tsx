'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Can } from '@/lib/permissions';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ChatItem, ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { MediaPicker } from './media-picker';
import { NoteComposer } from './note-composer';
import { SavedReplyPicker } from './saved-reply-picker';
import { PaymentRequestDialog } from './payment-request-dialog';
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
 * The box under a chat: a reply to the customer, or an internal note for the team (T095). Notes
 * work even when replies are locked (closed window, or a chat another member took).
 */
export function Composer(props: { chat: ConversationDetail; meId: string; onSent?: (item: ChatItem) => void }) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  return (
    <div className="border-t">
      <Can permission="inbox.reply">
        <div className="flex gap-1 px-3 pt-2" role="tablist" aria-label="Write">
          {(['reply', 'note'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('rounded-md px-2 py-1 text-xs hover:bg-accent', mode === m && 'bg-accent font-medium')}
            >
              {m === 'reply' ? 'Reply' : 'Note'}
            </button>
          ))}
        </div>
      </Can>
      {mode === 'note' ? <NoteComposer chat={props.chat} /> : <ReplyComposer {...props} />}
    </div>
  );
}

/**
 * Reply box (T036, T066): text up to 4096 characters (emoji from the system picker), saved
 * replies by typing "/", and files from the computer or the media library. The queued message
 * shows at once; ticks follow from live events. A failed send keeps the draft.
 */
function ReplyComposer({
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
    mutationFn: (body: Record<string, unknown>) =>
      api<ChatItem>(`/inbox/conversations/${chat.id}/messages`, {
        method: 'POST',
        json: body,
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

  // "/" at the start of the box opens the saved replies instead of sending text.
  const picking = draft.startsWith('/');
  const submit = () => {
    const text = draft.trim();
    if (!text || picking || send.isPending) return;
    send.mutate({ type: 'text', text });
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
        className="flex flex-wrap items-center justify-between gap-3 bg-muted/40 p-4 text-sm text-muted-foreground"
        data-testid="window-closed"
      >
        <span>
          🔒 The 24-hour reply window has closed. Free replies are locked until the customer writes
          again; a template can restart the conversation.
        </span>
        {mayAct && (
          <span className="flex gap-2">
            <PaymentRequestDialog chat={chat} />
            <TemplateSender chat={chat} />
          </span>
        )}
      </div>
    );
  }
  if (!chat.canReply) {
    return (
      <div className="bg-muted/40 p-4 text-sm text-muted-foreground">
        {chat.state === 'INTERVENED' && chat.intervenedBy
          ? `${chat.intervenedBy.name} has taken this chat.`
          : 'You cannot reply in this chat right now.'}
      </div>
    );
  }

  return (
    <form
      className="grid gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {picking && (
        <SavedReplyPicker
          query={draft.slice(1)}
          onSend={(reply, params) => send.mutate({ type: 'canned', cannedMessageId: reply.id, params })}
          onClose={() => setDraft('')}
        />
      )}
      <textarea
        aria-label="Reply"
        className="min-h-[72px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder='Type a reply… ("/" for saved replies, Enter to send, Shift+Enter for a new line)'
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
          <MediaPicker disabled={send.isPending} onSend={(item, caption) => send.mutate({ type: 'media', mediaAssetId: item.id, ...(caption.trim() ? { text: caption.trim() } : {}) })} />
          <PaymentRequestDialog chat={chat} />
          <TemplateSender chat={chat} variant="outline" />
          <Button type="submit" size="sm" disabled={!draft.trim() || picking || send.isPending}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </span>
      </div>
    </form>
  );
}
