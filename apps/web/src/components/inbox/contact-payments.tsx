'use client';

import { useQuery } from '@tanstack/react-query';
import type { PaymentDisplay } from '@wbm/shared';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { CHAT_ORDER_STATUS_LABEL, type ChatOrder } from '@/lib/catalog';
import { PAYMENT_DISPLAY_LABEL, PAYMENT_DISPLAY_TONE, paymentMoney, paymentsKeys, type PaymentRequest } from '@/lib/payments';

const TONE_VARIANT = { neutral: 'secondary', good: 'success', warn: 'warning', bad: 'destructive' } as const;

/** A contact's payment history, newest first (feature 008 US2, FR-016). */
export function ContactPayments({ contactId }: { contactId: string }) {
  const query = useQuery({ queryKey: paymentsKeys.contact(contactId), queryFn: () => api<{ requests: PaymentRequest[]; chatOrders?: ChatOrder[] }>(`/contacts/${contactId}/payments`) });
  const requests = query.data?.requests ?? [];
  const orders = query.data?.chatOrders ?? [];
  return (
    <section className="mb-4" data-testid="contact-payments">
      <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Payments</h4>
      {query.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
      {query.isSuccess && requests.length === 0 ? <p className="text-xs text-muted-foreground">No payment requests yet.</p> : null}
      <ul className="grid gap-2">
        {requests.slice(0, 10).map((r) => (
          <li key={r.id} className="grid gap-0.5 rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{paymentMoney(r.amountMinor, r.currency)}</span>
              <Badge variant={TONE_VARIANT[PAYMENT_DISPLAY_TONE[r.display as PaymentDisplay] ?? 'neutral']}>{PAYMENT_DISPLAY_LABEL[r.display as PaymentDisplay] ?? r.display}</Badge>
            </div>
            <span className="break-words text-xs">{r.description}</span>
            <span className="text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {orders.length ? (
        <>
          <h4 className="mb-2 mt-3 text-xs font-semibold uppercase text-muted-foreground">Chat orders</h4>
          <ul className="grid gap-2" data-testid="contact-chat-orders">
            {orders.slice(0, 10).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <span className="font-medium">{paymentMoney(o.totalMinor, o.currency)}</span>
                <span className="text-xs text-muted-foreground">{o.items.length} item{o.items.length === 1 ? '' : 's'}</span>
                <Badge variant="outline">{CHAT_ORDER_STATUS_LABEL[o.status]}</Badge>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
