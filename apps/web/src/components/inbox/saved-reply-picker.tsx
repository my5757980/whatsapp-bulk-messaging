'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface SavedReply {
  id: string;
  name: string;
  type: 'TEXT' | 'MEDIA';
  text?: string;
  favorite: boolean;
  parameterCount: number;
}

export const savedRepliesKey = ['canned-messages'] as const;

/**
 * Saved replies for the reply box (T066, FR-031): typing "/" lists them (favourites first);
 * a reply with numbered parameters asks for them before it is sent.
 */
export function SavedReplyPicker({ query, onSend, onClose }: { query: string; onSend: (reply: SavedReply, params: Record<string, string>) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<SavedReply | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const replies = useQuery({ queryKey: savedRepliesKey, queryFn: () => api<SavedReply[]>('/canned-messages') });
  const q = query.trim().toLowerCase();
  const matches = (replies.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.text?.toLowerCase().includes(q)).slice(0, 8);

  const star = useMutation({
    mutationFn: (reply: SavedReply) => api(`/canned-messages/${reply.id}/favorite`, { method: reply.favorite ? 'DELETE' : 'PUT' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: savedRepliesKey }),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not update favourites'),
  });

  const pick = (reply: SavedReply) => {
    if (reply.parameterCount > 0) {
      setChosen(reply);
      setParams({});
    } else {
      onSend(reply, {});
    }
  };

  if (chosen) {
    const missing = Array.from({ length: chosen.parameterCount }, (_, i) => String(i + 1)).filter((n) => !params[n]?.trim());
    return (
      <div className="grid gap-2 rounded-md border bg-card p-3 shadow-sm" aria-label="Saved reply parameters">
        <p className="text-sm font-medium">{chosen.name}</p>
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{chosen.text}</p>
        {Array.from({ length: chosen.parameterCount }, (_, i) => String(i + 1)).map((n) => (
          <Input key={n} aria-label={`Parameter ${n}`} placeholder={`{{${n}}}`} maxLength={1024} value={params[n] ?? ''} onChange={(e) => setParams({ ...params, [n]: e.target.value })} />
        ))}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setChosen(null)}>
            Back
          </Button>
          <Button type="button" size="sm" disabled={missing.length > 0} onClick={() => onSend(chosen, params)}>
            Send
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card shadow-sm" role="listbox" aria-label="Saved replies">
      {replies.isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
      {!replies.isLoading && matches.length === 0 && <p className="p-3 text-sm text-muted-foreground">No saved reply matches.</p>}
      {matches.map((reply) => (
        <div key={reply.id} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-accent">
          <button type="button" role="option" aria-selected={false} className="min-w-0 flex-1 text-left" onClick={() => pick(reply)}>
            <span className="block truncate text-sm font-medium">{reply.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{reply.type === 'MEDIA' ? '📎 File' : reply.text}</span>
          </button>
          <button
            type="button"
            aria-label={reply.favorite ? `Remove ${reply.name} from favourites` : `Add ${reply.name} to favourites`}
            className={cn('text-lg leading-none', reply.favorite ? 'text-amber-500' : 'text-muted-foreground')}
            onClick={() => star.mutate(reply)}
          >
            {reply.favorite ? '★' : '☆'}
          </button>
        </div>
      ))}
      <div className="flex justify-end p-1">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
