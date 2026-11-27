'use client';

import { useQuery } from '@tanstack/react-query';
import type { PaymentDisplay } from '@wbm/shared';
import Link from 'next/link';
import { use } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { PAYMENT_DISPLAY_LABEL, PAYMENT_SOURCE_LABEL, paymentMoney, paymentsKeys, type PaymentRequestDetail } from '@/lib/payments';

/** One payment request (feature 008, T044): its state, the message that carried it and the Stripe events. */
export default function PaymentRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequirePermission permission="payments.view">
      <Request id={id} />
    </RequirePermission>
  );
}

function Request({ id }: { id: string }) {
  const query = useQuery({ queryKey: paymentsKeys.request(id), queryFn: () => api<PaymentRequestDetail>(`/payments/requests/${id}`) });
  const r = query.data;
  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!r) return <p className="text-sm text-muted-foreground">This payment request was not found.</p>;
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-3 gap-2 border-b py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2">{value}</dd>
    </div>
  );
  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <Link href="/payments" className="text-sm text-muted-foreground hover:underline">
          ← Payments
        </Link>
        <h1 className="text-2xl font-semibold">{r.description}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {paymentMoney(r.amountMinor, r.currency)}
            <Badge>{PAYMENT_DISPLAY_LABEL[r.display as PaymentDisplay] ?? r.display}</Badge>
            {r.isTest ? <Badge variant="outline">Test</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="text-sm">
            {row('Customer', r.contactName ?? r.phone ?? '—')}
            {row('Reference', r.reference ?? '—')}
            {row('Source', PAYMENT_SOURCE_LABEL[r.source])}
            {row('Asked by', r.createdBy?.name ?? '—')}
            {row('Made', new Date(r.createdAt).toLocaleString())}
            {row('Expires', new Date(r.expiresAt).toLocaleString())}
            {row('Paid', r.paidAt ? `${new Date(r.paidAt).toLocaleString()}${r.paidLate ? ' (late)' : ''}` : '—')}
            {row('Refunded', r.refundedMinor ? paymentMoney(r.refundedMinor, r.currency) : '—')}
            {row('Failed attempts', r.failedAttempts ? `${r.failedAttempts}${r.lastFailureCode ? ` (${r.lastFailureCode})` : ''}` : '—')}
            {row('Message', r.delivery ?? '—')}
            {row('Opens', r.opens)}
            {row('Pay link', <code className="break-all text-xs">{r.payUrl}</code>)}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Stripe notifications</CardTitle>
        </CardHeader>
        <CardContent>
          {r.events.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : null}
          <ul className="grid gap-1 text-sm">
            {r.events.map((e, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span>{e.type}</span>
                <span className="text-muted-foreground">
                  {e.result.toLowerCase()}
                  {e.source === 'RECONCILE' ? ' (found later)' : ''} · {new Date(e.receivedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
