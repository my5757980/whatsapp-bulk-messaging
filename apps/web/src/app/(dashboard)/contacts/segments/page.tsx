'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { contacts010Keys, type Segment, type SegmentCount } from '@/lib/contacts-010';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';

// Feature 010 (US1, FR-001 – FR-003): saved segments with their counts.

export default function SegmentsPage() {
  return (
    <RequirePermission permission="contacts.view">
      <SegmentList />
    </RequirePermission>
  );
}

function CountCell({ id }: { id: string }) {
  const count = useQuery({ queryKey: contacts010Keys.segmentCount(id), queryFn: () => api<SegmentCount>(`/segments/${id}/count`), staleTime: 30_000 });
  if (count.isLoading) return <span className="text-muted-foreground">…</span>;
  if (!count.data) return <span className="text-muted-foreground">—</span>;
  return (
    <span>
      {formatNumber(count.data.count)} <span className="text-xs text-muted-foreground">({formatNumber(count.data.marketable)} can get marketing)</span>
    </span>
  );
}

function SegmentList() {
  const segments = useQuery({ queryKey: contacts010Keys.segments, queryFn: () => api<{ items: Segment[] }>('/segments') });
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/contacts" className="text-sm text-muted-foreground hover:underline">
            ← Contacts
          </Link>
          <h1 className="text-2xl font-semibold">Segments</h1>
          <p className="text-sm text-muted-foreground">Saved audiences that stay up to date. Use them for campaigns, drips and filters.</p>
        </div>
        <Can permission="campaigns.manage">
          <Button asChild>
            <Link href="/contacts/segments/new">New segment</Link>
          </Button>
        </Can>
      </div>
      <Card>
        <CardContent className="p-0">
          {segments.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : segments.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(segments.error)}</p>
          ) : !segments.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">No segments yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Contacts now</TableHead>
                  <TableHead>Used by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.data.items.map((s) => (
                  <TableRow key={s.id} data-testid="segment-row">
                    <TableCell>
                      <Link href={`/contacts/segments/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      {s.broken.length ? (
                        <Badge variant="destructive" className="ml-2">
                          Needs a fix
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <CountCell id={s.id} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.usedBy.length ? s.usedBy.map((c) => c.name).join(', ') : '—'}</TableCell>
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
