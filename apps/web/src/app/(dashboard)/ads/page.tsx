'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { OtherAdChats } from '@/components/ads/other-ad-chats';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AD_GOAL_LABEL, AD_STATUS_LABEL, AD_STATUS_VARIANT, adsKeys, money, type AdCampaignSummary, type AdsConnection } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Can } from '@/lib/permissions';

/** Ads: the platform's ad campaigns with state, spend and results (feature 007 US2, FR-028). */
export default function AdsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <Ads />
    </RequirePermission>
  );
}

function Ads() {
  const connection = useQuery({ queryKey: adsKeys.connection, queryFn: () => api<{ connection: AdsConnection | null }>('/ads/connection') });
  const campaigns = useQuery({ queryKey: adsKeys.campaigns, queryFn: () => api<AdCampaignSummary[]>('/ads/campaigns'), refetchInterval: 30_000 });
  const current = connection.data?.connection;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Ads</h1>
          <p className="text-sm text-muted-foreground">Click-to-WhatsApp, lead form and website ads on Facebook, Instagram and WhatsApp Status.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/ads/audiences">Audiences</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/ads/lead-forms">Lead forms</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/ads/connect">Ad account</Link>
          </Button>
          <Can permission="campaigns.manage">
            {current ? (
              <Button asChild>
                <Link href="/ads/new">New ad</Link>
              </Button>
            ) : null}
          </Can>
        </div>
      </div>

      {connection.isSuccess && !current ? (
        <Card>
          <CardContent className="grid gap-2 pt-6 text-sm">
            <p>No ad account is connected yet.</p>
            <Link href="/ads/connect" className="font-medium underline">
              Connect the ad account and page
            </Link>
          </CardContent>
        </Card>
      ) : null}
      {current?.status === 'ERROR' ? (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          The ads connection needs attention: new ads and changes are on hold. <Link href="/ads/connect" className="underline">Open the connection</Link>
        </p>
      ) : null}

      {campaigns.data?.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Daily budget</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Chats / leads</TableHead>
              <TableHead>Start</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link href={`/ads/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell>{AD_GOAL_LABEL[c.goal]}</TableCell>
                <TableCell>
                  <Badge variant={AD_STATUS_VARIANT[c.status]}>{AD_STATUS_LABEL[c.status]}</Badge>
                </TableCell>
                <TableCell className="text-right">{money(c.dailyBudgetMinor, c.currency)}</TableCell>
                <TableCell className="text-right">{money(c.spendMinor, c.currency)}</TableCell>
                <TableCell className="text-right">{c.goal === 'LEADS' ? c.leads : c.chatsStarted}</TableCell>
                <TableCell>{formatDateTime(c.startAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : campaigns.isSuccess ? (
        <p className="text-sm text-muted-foreground">No ad campaigns yet.</p>
      ) : null}

      <OtherAdChats />
    </div>
  );
}
