'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ClickResults } from '@/components/campaigns/click-results';
import { RetargetDialog } from '@/components/campaigns/retarget-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber, totalRecipients } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { CampaignDetail, StatusTotals } from '@/lib/types';

interface CampaignReport {
  campaignId: string;
  totals: StatusTotals;
  deliveryRate: number;
  readRate: number;
  failureReasons: Array<{ code: number | null; reason: string; count: number }>;
  estimatedCostUsd: number;
  costIsEstimate: true;
}

const percent = (v: number) => `${(v * 100).toFixed(1)}%`;
const usd = (v: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(v);

/** Campaign report (T164): stat cards, rates, failure reasons, cost estimate, export and retarget. */
export default function CampaignReportPage() {
  const { id } = useParams<{ id: string }>();
  const campaign = useQuery({ queryKey: queryKeys.campaign(id), queryFn: () => api<CampaignDetail>(`/campaigns/${id}`) });
  const report = useQuery({ queryKey: ['campaign', id, 'report'], queryFn: () => api<CampaignReport>(`/campaigns/${id}/report`) });
  const [retargetOpen, setRetargetOpen] = useState(false);

  if (report.isLoading || campaign.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (report.error || !report.data) return <p className="text-sm text-destructive">{errorMessage(report.error)}</p>;
  const r = report.data;
  const t = r.totals;
  const cards: Array<[string, number, string]> = [
    ['Recipients', totalRecipients(t), 'total'],
    ['Sent', t.sent + t.delivered + t.read + t.failed, 'sent'],
    ['Delivered', t.delivered + t.read, 'delivered'],
    ['Read', t.read, 'read'],
    ['Failed', t.failed, 'failed'],
    ['Skipped', t.skipped, 'skipped'],
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/campaigns/${id}`} className="text-sm text-muted-foreground hover:underline">
            ← {campaign.data?.name ?? 'Campaign'}
          </Link>
          <h1 className="text-2xl font-semibold">Report</h1>
        </div>
        <Can permission="data.export">
          <Button variant="outline" asChild>
            <a href={`/api/campaigns/${id}/export`} download>
              Export recipients (CSV)
            </a>
          </Button>
        </Can>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map(([label, value, key]) => (
          <Card key={key}>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold" data-testid={`report-${key}`}>
                {formatNumber(value)}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Delivery rate</CardDescription>
            <CardTitle className="text-3xl" data-testid="delivery-rate">
              {percent(r.deliveryRate)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Read rate</CardDescription>
            <CardTitle className="text-3xl" data-testid="read-rate">
              {percent(r.readRate)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Estimated cost (from your rate card)</CardDescription>
            <CardTitle className="text-3xl" data-testid="estimated-cost">
              {usd(r.estimatedCostUsd)}
            </CardTitle>
            <CardDescription>An estimate only; Meta&apos;s invoice is final.</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <ClickResults campaignId={id} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Failure reasons</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {r.failureReasons.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reason</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Recipients</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.failureReasons.map((f) => (
                  <TableRow key={`${f.code}-${f.reason}`}>
                    <TableCell>{f.reason}</TableCell>
                    <TableCell className="text-muted-foreground">{f.code ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatNumber(f.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">No failures.</p>
          )}
        </CardContent>
      </Card>

      <Can permission="campaigns.manage">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retarget</CardTitle>
            <CardDescription>
              Create a new draft for the people with a given result: clicked, replied, read, failed and more. You see how many first; contacts who
              opted out are left out automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => setRetargetOpen(true)}>
              Retarget…
            </Button>
          </CardContent>
        </Card>
        <RetargetDialog campaignId={id} open={retargetOpen} onOpenChange={setRetargetOpen} />
      </Can>
    </div>
  );
}
