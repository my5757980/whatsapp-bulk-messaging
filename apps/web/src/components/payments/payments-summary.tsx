'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { PAYMENT_SOURCE_LABEL, paymentMoney, paymentsKeys, type PaymentTotals, type PaymentsSummary } from '@/lib/payments';
import { Can } from '@/lib/permissions';

/** YYYY-MM-DD of a local date. */
export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The last 30 days, today included. */
export function defaultPeriod(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

const TILES: Array<{ key: 'requested' | 'paid' | 'waiting' | 'expired' | 'refunded'; label: string }> = [
  { key: 'requested', label: 'Requested' },
  { key: 'paid', label: 'Paid' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'expired', label: 'Expired' },
  { key: 'refunded', label: 'Refunded' },
];

const amountOf = (t: PaymentTotals, key: (typeof TILES)[number]['key']) => t[`${key}Minor`];
const countOf = (t: PaymentTotals, key: (typeof TILES)[number]['key']) => t[`${key}Count`];

/**
 * The payments page's totals (feature 008 US4, FR-019): tiles for the period, paid per day, and the
 * totals by source. Test requests are left out by the API.
 */
export function PaymentsSummaryPanel({ from, to, source }: { from: string; to: string; source?: string }) {
  const summary = useQuery({
    queryKey: paymentsKeys.summary(from, to, source),
    queryFn: () => api<PaymentsSummary>(`/payments/summary?from=${from}&to=${to}${source ? `&source=${source}` : ''}`),
  });
  if (summary.isLoading) return <p className="text-sm text-muted-foreground">Loading totals…</p>;
  if (!summary.data) return null;
  const { totals, currency } = summary.data;
  const money = (minor: number) => paymentMoney(minor, currency);

  return (
    <div className="grid gap-4" data-testid="payments-summary">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {TILES.map((tile) => (
          <Card key={tile.key} data-testid={`tile-${tile.key}`}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">{tile.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-semibold tabular-nums">{money(amountOf(totals, tile.key))}</div>
              <div className="text-xs text-muted-foreground">
                {formatNumber(countOf(totals, tile.key))} {countOf(totals, tile.key) === 1 ? 'request' : 'requests'}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <PaidPerDay days={summary.data.days} money={money} />
      {summary.data.sources.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By source</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm" data-testid="sources-table">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Source</th>
                  <th className="p-2 text-right">Requested</th>
                  <th className="p-2 text-right">Paid</th>
                  <th className="p-2 text-right">Waiting</th>
                  <th className="p-2 text-right">Expired</th>
                  <th className="p-2 text-right">Refunded</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.sources.map((s) => (
                  <tr key={s.source} className="border-t">
                    <td className="p-2">{PAYMENT_SOURCE_LABEL[s.source]}</td>
                    {TILES.map((tile) => (
                      <td key={tile.key} className="p-2 text-right tabular-nums">
                        {money(amountOf(s, tile.key))} <span className="text-xs text-muted-foreground">({formatNumber(countOf(s, tile.key))})</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** One series, so no legend: the title names it. Bars start at the baseline; a table view is one click away. */
function PaidPerDay({ days, money }: { days: PaymentsSummary['days']; money: (minor: number) => string }) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...days.map((d) => d.paidMinor));
  const anyPaid = days.some((d) => d.paidMinor > 0);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Paid per day</CardTitle>
        <Button type="button" variant="ghost" size="sm" onClick={() => setTable((v) => !v)}>
          {table ? 'Show chart' : 'Show table'}
        </Button>
      </CardHeader>
      <CardContent>
        {table ? (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm" data-testid="days-table">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-1">Day</th>
                  <th className="p-1 text-right">Paid</th>
                  <th className="p-1 text-right">Payments</th>
                  <th className="p-1 text-right">Requested</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day} className="border-t">
                    <td className="p-1">{d.day}</td>
                    <td className="p-1 text-right tabular-nums">{money(d.paidMinor)}</td>
                    <td className="p-1 text-right tabular-nums">{formatNumber(d.paidCount)}</td>
                    <td className="p-1 text-right tabular-nums">{formatNumber(d.requestedCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !anyPaid ? (
          <p className="text-sm text-muted-foreground">No payments in this period.</p>
        ) : (
          <div>
            <div className="flex h-40 items-end gap-0.5 border-b border-border" role="list" aria-label="Paid per day">
              {days.map((d) => (
                <div
                  key={d.day}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`${d.day}: ${money(d.paidMinor)} from ${d.paidCount} ${d.paidCount === 1 ? 'payment' : 'payments'}`}
                  className="group relative flex h-full min-w-0 flex-1 items-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="w-full rounded-t bg-primary transition-opacity group-hover:opacity-80" style={{ height: d.paidMinor ? `${Math.max(2, (d.paidMinor / max) * 100)}%` : '0%' }} />
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm group-hover:block group-focus-visible:block">
                    <div className="font-medium">{d.day}</div>
                    <div className="tabular-nums">
                      {money(d.paidMinor)} · {formatNumber(d.paidCount)} paid
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>{days[0]?.day}</span>
              <span>{days.at(-1)?.day}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The CSV export of the period (FR-020); needs data.export. */
export function PaymentsExportButton({ from, to, status, source }: { from: string; to: string; status?: string; source?: string }) {
  const params = new URLSearchParams({ from, to });
  if (status) params.set('status', status);
  if (source) params.set('source', source);
  return (
    <Can permission="data.export">
      <Button asChild variant="outline" size="sm">
        <a href={`/api/payments/export.csv?${params.toString()}`} download>
          Export CSV
        </a>
      </Button>
    </Can>
  );
}
