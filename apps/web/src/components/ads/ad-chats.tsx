'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adsKeys, type AdChatStart } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const PAGE_SIZE = 50;

/** Contacts who started chats from one campaign (feature 007 US3, FR-021); phones masked without phones.full. */
export function AdChats({ campaignId }: { campaignId: string }) {
  const [page, setPage] = useState(1);
  const chats = useQuery({
    queryKey: adsKeys.chats(campaignId, page),
    queryFn: () => api<{ items: AdChatStart[]; total: number }>(`/ads/campaigns/${campaignId}/chats?page=${page}&pageSize=${PAGE_SIZE}`),
    refetchInterval: 15_000,
  });
  const total = chats.data?.total ?? 0;
  if (chats.isSuccess && !total) return <p className="text-sm text-muted-foreground">No chats from this campaign yet.</p>;
  return (
    <div className="grid gap-2" data-testid="ad-chats">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contact</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Started</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(chats.data?.items ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                {c.contact?.name ?? 'Unknown'} {c.newContact ? <Badge variant="secondary">New contact</Badge> : null}
              </TableCell>
              <TableCell className="font-mono text-xs">{c.contact?.phone ?? '—'}</TableCell>
              <TableCell>{formatDateTime(c.startedAt)}</TableCell>
              <TableCell>
                {c.conversationId ? (
                  <Link href={`/inbox?c=${c.conversationId}`} className="text-sm underline">
                    Open chat
                  </Link>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {total > PAGE_SIZE ? (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page} of {Math.ceil(total / PAGE_SIZE)}
          </span>
          <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
