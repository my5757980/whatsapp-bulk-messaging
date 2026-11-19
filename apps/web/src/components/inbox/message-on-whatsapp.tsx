'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ConversationSummary } from '@/lib/inbox-types';

interface ChatNumber {
  id: string;
  label: string;
  displayPhoneNumber: string;
}

/** Opens (or creates) the contact's chat and goes to it (T044); asks for the number when there are several. */
export function MessageOnWhatsApp({ contactId }: { contactId: string }) {
  const router = useRouter();
  const [choosing, setChoosing] = useState(false);
  const [numberId, setNumberId] = useState('');
  const numbers = useQuery({ queryKey: ['inbox', 'numbers'], queryFn: () => api<ChatNumber[]>('/inbox/numbers') });

  const open = useMutation({
    mutationFn: (id: string) => api<ConversationSummary>('/inbox/conversations', { method: 'POST', json: { contactId, numberId: id } }),
    onSuccess: (chat) => router.push(`/inbox?c=${chat.id}`),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The chat could not be opened'),
  });

  const start = () => {
    const list = numbers.data ?? [];
    if (list.length === 1) open.mutate(list[0]!.id);
    else setChoosing(true);
  };

  if (numbers.data?.length === 0) return null;
  return (
    <>
      <Button variant="secondary" onClick={start} disabled={numbers.isLoading || open.isPending}>
        Message on WhatsApp
      </Button>
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Which number?</DialogTitle>
            <DialogDescription>The chat continues on the company number you choose.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="chat-number">Number</Label>
            <NativeSelect id="chat-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">Choose a number</option>
              {numbers.data?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.displayPhoneNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button onClick={() => open.mutate(numberId)} disabled={!numberId || open.isPending}>
              Open chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
