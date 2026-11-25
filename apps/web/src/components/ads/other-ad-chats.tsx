'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adsKeys } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

interface OtherAdGroup {
  metaAdId: string;
  headline: string | null;
  chats: number;
  newContacts: number;
  lastAt: string;
}

/** Chats from ads made outside the platform, by Meta's ad id (feature 007 US3, FR-022). */
export function OtherAdChats() {
  const groups = useQuery({ queryKey: adsKeys.otherChats(1), queryFn: () => api<OtherAdGroup[]>('/ads/other-chats'), refetchInterval: 30_000 });
  if (!groups.data?.length) return null;
  return (
    <Card data-testid="other-ad-chats">
      <CardHeader>
        <CardTitle className="text-base">Other ads</CardTitle>
        <CardDescription>Chats that started from ads made in Meta&apos;s tools, not here.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ad</TableHead>
              <TableHead className="text-right">Chats</TableHead>
              <TableHead className="text-right">New contacts</TableHead>
              <TableHead>Last chat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.data.map((g) => (
              <TableRow key={g.metaAdId}>
                <TableCell>
                  {g.headline ?? 'No headline'} <span className="font-mono text-xs text-muted-foreground">· {g.metaAdId}</span>
                </TableCell>
                <TableCell className="text-right">{g.chats}</TableCell>
                <TableCell className="text-right">{g.newContacts}</TableCell>
                <TableCell>{formatDateTime(g.lastAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
