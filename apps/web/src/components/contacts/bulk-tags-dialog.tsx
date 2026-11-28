'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { contacts010Keys, type BulkAction, type BulkSelection } from '@/lib/contacts-010';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import type { Tag } from '@/lib/types';

// Feature 010 (US2, FR-008, FR-009): add or remove tags on chosen contacts or on everyone matching the
// filter or segment; the action runs in the background and its progress shows here.

export function BulkTagsDialog({ selection, count, tags, onDone }: { selection: BulkSelection; count: number; tags: Tag[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'TAG_ADD' | 'TAG_REMOVE'>('TAG_ADD');
  const [tagId, setTagId] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<BulkAction>('/contacts/bulk-actions', { method: 'POST', json: { kind, tagIds: [tagId], selection } }),
    onSuccess: (action) => {
      setError(null);
      setActionId(action.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const action = useQuery({
    queryKey: contacts010Keys.bulkAction(actionId ?? 'none'),
    queryFn: () => api<BulkAction>(`/contacts/bulk-actions/${actionId}`),
    enabled: Boolean(actionId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'DONE' || q.state.data.status === 'FAILED') ? false : 2_000),
  });
  const finished = action.data?.status === 'DONE' || action.data?.status === 'FAILED';
  const scope = 'contactIds' in selection ? `${formatNumber(count)} chosen contacts` : `all ${formatNumber(count)} matching contacts`;

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      if (finished) {
        onDone();
        void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      }
      setActionId(null);
      setTagId('');
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!count}>
          {'contactIds' in selection ? 'Tags for chosen…' : 'Tags for all matching…'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add or remove tags</DialogTitle>
          <DialogDescription>This changes {scope}. It runs in the background, so you can leave this page.</DialogDescription>
        </DialogHeader>
        {actionId ? (
          <div className="grid gap-2 text-sm" data-testid="bulk-progress">
            <p>
              {action.data?.status === 'DONE'
                ? `Done: ${formatNumber(action.data.changed)} changed of ${formatNumber(action.data.processed)}.`
                : action.data?.status === 'FAILED'
                  ? `Stopped: ${action.data.error ?? 'unknown error'}`
                  : `Working… ${formatNumber(action.data?.processed ?? 0)} of ${formatNumber(action.data?.total ?? count)}`}
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-kind">Action</Label>
              <NativeSelect id="bulk-kind" value={kind} onChange={(e) => setKind(e.target.value as 'TAG_ADD' | 'TAG_REMOVE')}>
                <option value="TAG_ADD">Add a tag</option>
                <option value="TAG_REMOVE">Remove a tag</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-tag">Tag</Label>
              <NativeSelect id="bulk-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                <option value="">Choose a tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {actionId ? (
            <Button onClick={() => close(false)}>{finished ? 'Done' : 'Keep running and close'}</Button>
          ) : (
            <Button onClick={() => start.mutate()} disabled={!tagId || start.isPending}>
              {kind === 'TAG_ADD' ? 'Add tag' : 'Remove tag'} for {formatNumber(count)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
