'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formsKeys, type FormSummary } from '@/lib/forms';
import type { ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';

/** Send a published WhatsApp Form in the 24-hour window (feature 008 US7, FR-033). */
export function FormSender({ chat }: { chat: ConversationDetail }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [formId, setFormId] = useState('');
  const [body, setBody] = useState('');
  const [cta, setCta] = useState('Open form');
  const [error, setError] = useState<string | null>(null);
  const forms = useQuery({ queryKey: formsKeys.list('PUBLISHED'), queryFn: () => api<{ items: FormSummary[] }>('/forms?status=PUBLISHED'), enabled: open });
  const send = useMutation({
    mutationFn: () => api<{ chatItemId: string }>(`/inbox/conversations/${chat.id}/forms`, { method: 'POST', json: { formId, body: body.trim(), cta: cta.trim() } }),
    onSuccess: () => {
      toast.success('Form sent');
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
      setOpen(false);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate();
  };
  const published = (forms.data?.items ?? []).filter((f) => f.status === 'PUBLISHED');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Send form
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>Send form</DialogTitle>
            <DialogDescription>The customer fills it in inside WhatsApp; the answer comes back to this chat.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="send-form">Form</Label>
            <NativeSelect id="send-form" value={formId} onChange={(e) => setFormId(e.target.value)}>
              <option value="">Choose a published form…</option>
              {published.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="send-form-body">Message</Label>
            <Input id="send-form-body" maxLength={1024} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="send-form-cta">Button</Label>
            <Input id="send-form-cta" maxLength={30} value={cta} onChange={(e) => setCta(e.target.value)} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!formId || !body.trim() || !cta.trim() || send.isPending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
