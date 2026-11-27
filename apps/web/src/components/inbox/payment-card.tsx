'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import type { ChatPaymentSummary } from '@/lib/inbox-types';
import { PAYMENT_DISPLAY_LABEL, PAYMENT_DISPLAY_TONE, paymentMoney } from '@/lib/payments';
import { queryKeys } from '@/lib/query';
import type { PaymentDisplay } from '@wbm/shared';

const TONE_VARIANT = { neutral: 'secondary', good: 'success', warn: 'warning', bad: 'destructive' } as const;

/** A payment request in the chat (feature 008 US2): amount, what it is for, its state, and actions. */
export function PaymentCard({ payment }: { payment: ChatPaymentSummary }) {
  const queryClient = useQueryClient();
  const display = payment.display as PaymentDisplay;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
  };
  const cancel = useMutation({
    mutationFn: () => api(`/payments/requests/${payment.id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Payment request cancelled');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resend = useMutation({
    mutationFn: () => api(`/payments/requests/${payment.id}/resend`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Sent again');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payment.payUrl);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };
  const waiting = payment.status === 'WAITING';

  return (
    <div className="mt-1 grid gap-2 rounded-md border bg-background p-2 text-sm" data-testid={`payment-card-${payment.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">💳 {paymentMoney(payment.amountMinor, payment.currency)}</span>
        <Badge variant={TONE_VARIANT[PAYMENT_DISPLAY_TONE[display] ?? 'neutral']}>{PAYMENT_DISPLAY_LABEL[display] ?? payment.display}</Badge>
      </div>
      <p className="break-words">{payment.description}</p>
      {waiting ? <p className="text-xs text-muted-foreground">Pay by {new Date(payment.expiresAt).toLocaleString()}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          Copy link
        </Button>
        {display === 'NOT_DELIVERED' ? (
          <Button type="button" size="sm" variant="outline" onClick={() => resend.mutate()} disabled={resend.isPending}>
            Send again
          </Button>
        ) : null}
        {waiting ? (
          <ConfirmDialog
            trigger={
              <Button type="button" size="sm" variant="ghost" className="text-destructive">
                Cancel request
              </Button>
            }
            title="Cancel this payment request?"
            description="The link stops taking payments. The customer sees that the request was cancelled if they open it."
            confirmLabel="Cancel the request"
            confirmVariant="destructive"
            onConfirm={() => cancel.mutateAsync()}
          />
        ) : null}
      </div>
    </div>
  );
}
