'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ChatItem, ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';

const MAX_NOTE_LENGTH = 4096;
const MAX_MENTIONS = 10;

interface Member {
  id: string;
  name: string;
}

/** The "@name" being typed at the end of the note, if any. */
function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match ? match[1]! : null;
}

/**
 * Internal note box (T095, FR-038): only the team sees notes and they are never sent. Typing "@"
 * offers the members who can see this chat; mentioned teammates are alerted.
 */
export function NoteComposer({ chat }: { chat: ConversationDetail }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [mentioned, setMentioned] = useState<Member[]>([]);
  const members = useQuery({
    queryKey: ['inbox', 'members', chat.id],
    queryFn: () => api<Member[]>(`/inbox/members?conversationId=${chat.id}`),
    staleTime: 60_000,
  });
  const query = mentionQuery(text);
  const candidates =
    query === null
      ? []
      : (members.data ?? []).filter((m) => m.name.toLowerCase().includes(query.toLowerCase()) && !mentioned.some((x) => x.id === m.id)).slice(0, 6);

  const pick = (member: Member) => {
    setText(text.replace(/@([^\s@]*)$/, `@${member.name} `));
    setMentioned((current) => (current.length >= MAX_MENTIONS ? current : [...current, member]));
  };

  const add = useMutation({
    mutationFn: () => {
      // A mention counts only while its "@name" is still in the note.
      const ids = mentioned.filter((m) => text.includes(`@${m.name}`)).map((m) => m.id);
      return api<ChatItem>(`/inbox/conversations/${chat.id}/notes`, { method: 'POST', json: { text: text.trim(), ...(ids.length ? { mentions: ids } : {}) } });
    },
    onSuccess: () => {
      setText('');
      setMentioned([]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The note could not be saved'),
  });

  const submit = () => {
    if (!text.trim() || add.isPending) return;
    add.mutate();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (candidates[0]) pick(candidates[0]);
    else submit();
  };

  return (
    <form
      className="grid gap-2 bg-amber-50/60 p-3 dark:bg-amber-950/30"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {candidates.length > 0 && (
        <ul role="listbox" aria-label="Mention a teammate" className="max-h-40 overflow-y-auto rounded-md border bg-background text-sm shadow-sm">
          {candidates.map((member) => (
            <li key={member.id} role="option" aria-selected={false}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-accent" onClick={() => pick(member)}>
                {member.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="Note"
        className="min-h-[72px] w-full resize-y rounded-md border border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 dark:bg-amber-950"
        placeholder="Internal note: only your team sees it. Type @ to mention a teammate."
        maxLength={MAX_NOTE_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Notes are never sent to the customer.</span>
        <Button type="submit" size="sm" disabled={!text.trim() || add.isPending}>
          {add.isPending ? 'Saving…' : 'Add note'}
        </Button>
      </div>
    </form>
  );
}
