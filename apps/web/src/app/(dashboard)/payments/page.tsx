'use client';

import { useQuery } from '@tanstack/react-query';
import type { PaymentDisplay, PaymentSource, PaymentStatus } from '@wbm/shared';
import Link from 'next/link';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { PAYMENT_DISPLAY_LABEL, PAYMENT_DISPLAY_TONE, PAYMENT_SOURCE_LABEL, paymentMoney, paymentsKeys, type PaymentRequest } from '@/lib/payments';
import { Can } from '@/lib/permissions';

const TONE_VARIANT = { neutral: 'secondary', good: 'success', warn: 'warning', bad: 'destructive' } as const;
const STATUSES: PaymentStatus[] = ['WAITING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'];
const SOURCES: PaymentSource[] = ['INBOX', 'FLOW', 'CAMPAIGN', 'API', 'STORE_ORDER', 'CHAT_ORDER'];

/** Payments (feature 008): every payment request with filters; US4 adds totals and export. */
export default function PaymentsPage() {
  return (
    <RequirePermission permission="payments.view">
      <Payments />
    </RequirePermission>
  );
}

function Payments() {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const filters = { status: status || undefined, source: source || undefined, page };
  const query = useQuery({
    queryKey: paymentsKeys.requests(filters),
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (status) params.set('status', status);
      if (source) params.set('source', source);
      return api<{ items: PaymentRequest[]; total: number }>(`/payments/requests?${params.toString()}`);
    },
  });
  const items = query.data?.items ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Payments</h1>
          <p className="text-sm text-muted-foreground">Payment requests from live chat, flows, campaigns, the API and orders.</p>
        </div>
        <div className="flex gap-2">
          <Can permission="payments.view">
            <Button asChild variant="outline" size="sm">
              <Link href="/payments/settings">Settings</Link>
            </Button>
          </Can>
          <Button asChild variant="outline" size="sm">
            <Link href="/payments/gateway">Stripe connection</Link>
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Source" value={source} onChange={(e) => (setSource(e.target.value), setPage(1))}>
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {PAYMENT_SOURCE_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {query.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {query.isSuccess && items.length === 0 ? <p className="text-sm text-muted-foreground">No payment requests yet.</p> : null}
      {items.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="payments-table">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Customer</th>
                <th className="p-2">What for</th>
                <th className="p-2">Amount</th>
                <th className="p-2">Status</th>
                <th className="p-2">Source</th>
                <th className="p-2">Made</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.contactName ?? r.phone ?? '—'}</td>
                  <td className="p-2">
                    <Link href={`/payments/${r.id}`} className="hover:underline">
                      {r.description}
                    </Link>
                  </td>
                  <td className="p-2">{paymentMoney(r.amountMinor, r.currency)}</td>
                  <td className="p-2">
                    <Badge variant={TONE_VARIANT[PAYMENT_DISPLAY_TONE[r.display as PaymentDisplay] ?? 'neutral']}>{PAYMENT_DISPLAY_LABEL[r.display as PaymentDisplay] ?? r.display}</Badge>
                    {r.isTest ? <Badge variant="outline" className="ml-1">Test</Badge> : null}
                  </td>
                  <td className="p-2">{PAYMENT_SOURCE_LABEL[r.source]}</td>
                  <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {query.data && query.data.total > 50 ? (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page * 50 >= query.data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
