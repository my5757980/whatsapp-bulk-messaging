'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ConversationSummary } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';

interface Member {
  id: string;
  name: string;
  role: 'ADMIN' | 'MANAGER' | 'AGENT';
}

/** Hands a taken chat to another member (T055, FR-022). The server checks the target may see it. */
export function TransferDialog({ chatId, ownerId }: { chatId: string; ownerId: string | null }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const members = useQuery({ queryKey: ['inbox', 'members'], queryFn: () => api<Member[]>('/inbox/members'), enabled: open });

  const transfer = useMutation({
    mutationFn: () => api<ConversationSummary>(`/inbox/conversations/${chatId}/transfer`, { method: 'POST', json: { userId } }),
    onSuccess: (summary) => {
      toast.success(`Chat transferred to ${summary.intervenedBy?.name ?? 'the member'}`);
      setOpen(false);
      setUserId('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(chatId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The chat could not be transferred'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Transfer
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer this chat</DialogTitle>
          <DialogDescription>The member you choose takes over the chat and gets an alert.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="transfer-member">Member</Label>
          <NativeSelect id="transfer-member" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{members.isLoading ? 'Loading…' : 'Choose a member'}</option>
            {members.data
              ?.filter((m) => m.id !== ownerId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role.toLowerCase()})
                </option>
              ))}
          </NativeSelect>
        </div>
        <DialogFooter>
          <Button onClick={() => transfer.mutate()} disabled={!userId || transfer.isPending}>
            Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
