'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';
import type { ChatWidget } from './widget-types';

// Feature 009 (US8, FR-039 - FR-044): the website chat buttons with their last 30 days.
export default function WebsiteButtonsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <WebsiteButtons />
    </RequirePermission>
  );
}

function WebsiteButtons() {
  const list = useQuery({ queryKey: ['chat-widgets'], queryFn: () => api<{ items: ChatWidget[] }>('/chat-widgets') });
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Website chat button</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">A WhatsApp button for your website. Paste one line of code once; changes here show on the site without pasting it again.</p>
        </div>
        <Can permission="campaigns.manage">
          <Button asChild>
            <Link href="/website-button/new">New button</Link>
          </Button>
        </Can>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : list.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(list.error)}</p>
          ) : !list.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No buttons yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Opens (30 days)</TableHead>
                  <TableHead className="text-right">Chats (30 days)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((w) => (
                  <TableRow key={w.id} data-testid="widget-row">
                    <TableCell>
                      <Link href={`/website-button/${w.id}`} className="font-medium hover:underline">
                        {w.name}
                      </Link>
                    </TableCell>
                    <TableCell>{w.numberLabel}</TableCell>
                    <TableCell>
                      <Badge variant={w.status === 'ACTIVE' && w.numberConnected ? 'default' : 'secondary'}>{w.status === 'PAUSED' ? 'Paused' : w.numberConnected ? 'Showing' : 'Hidden (number not connected)'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(w.last30Days.opens)}</TableCell>
                    <TableCell className="text-right">{formatNumber(w.last30Days.chatsStarted)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
