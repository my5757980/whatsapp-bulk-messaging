'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { currencyExponent, toMinorUnits } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import type { ConversationDetail } from '@/lib/inbox-types';
import { paymentsKeys, type PaymentGateway, type PaymentRequest } from '@/lib/payments';
import { usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';

const EXPIRY_OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '7 days' },
];

/**
 * Request payment (feature 008 US2, FR-007): amount, what it is for, an optional reference and the
 * expiry. In the window the customer gets a Pay now message; outside it the payment template.
 */
export function PaymentRequestDialog({ chat, variant = 'outline' }: { chat: ConversationDetail; variant?: 'default' | 'outline' }) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [expiry, setExpiry] = useState(1440);
  const [error, setError] = useState<string | null>(null);
  // Agents cannot read the connection; the platform's payments are in AED unless Stripe says otherwise.
  const gateway = useQuery({ queryKey: paymentsKeys.gateway, queryFn: () => api<{ gateway: PaymentGateway | null }>('/payments/gateway'), enabled: open && can('payments.view') });
  const currency = gateway.data?.gateway?.currency ?? 'aed';

  const send = useMutation({
    mutationFn: () =>
      api<PaymentRequest>(`/inbox/conversations/${chat.id}/payment-requests`, {
        method: 'POST',
        json: {
          amountMinor: toMinorUnits(Number(amount), currency),
          description: description.trim(),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          expiresInMinutes: expiry,
        },
      }),
    onSuccess: () => {
      toast.success('Payment request sent');
      setOpen(false);
      setAmount('');
      setDescription('');
      setReference('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(chat.id) });
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = Number(amount) > 0 && description.trim().length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) send.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={variant}>
          Request payment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request payment</DialogTitle>
          <DialogDescription>The customer pays on Stripe&apos;s secure page; card details never reach this platform.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="pay-amount">Amount ({currency.toUpperCase()})</Label>
            <Input id="pay-amount" type="number" inputMode="decimal" min="0" step={1 / 10 ** currencyExponent(currency)} value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pay-description">What it is for</Label>
            <Input id="pay-description" maxLength={250} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Order 1042" required />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pay-reference">Reference (optional)</Label>
            <Input id="pay-reference" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Order number" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pay-expiry">Expires in</Label>
            <NativeSelect id="pay-expiry" value={String(expiry)} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!valid || send.isPending}>
              {send.isPending ? 'Sending…' : 'Send request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
