'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { DRIP_STATUS_LABEL, DRIP_STATUS_VARIANT, growthKeys, type DripDetail, type DripStatus, type DripSummary } from '@/lib/growth';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';

/** Drip campaigns (feature 005 US4): a series of template messages each contact receives with waits between them. */
export default function DripsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <DripList />
    </RequirePermission>
  );
}

function DripList() {
  const [status, setStatus] = useState<'' | DripStatus>('');
  const [creating, setCreating] = useState(false);
  const drips = useQuery({ queryKey: [...growthKeys.dripList, status], queryFn: () => api<DripSummary[]>(`/drips${status ? `?status=${status}` : ''}`) });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Drips</h1>
          <p className="text-sm text-muted-foreground">Series of template messages sent to each contact with waits between them, until they finish or leave.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="drip-status-filter">Status</Label>
            <NativeSelect id="drip-status-filter" value={status} onChange={(e) => setStatus(e.target.value as '' | DripStatus)}>
              <option value="">All drips</option>
              {(Object.keys(DRIP_STATUS_LABEL) as DripStatus[]).map((s) => (
                <option key={s} value={s}>
                  {DRIP_STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Can permission="campaigns.manage">
            <Button onClick={() => setCreating(true)}>New drip</Button>
          </Can>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {drips.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(drips.error)}</p>
          ) : drips.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead className="text-right">Steps</TableHead>
                  <TableHead className="text-right">In it now</TableHead>
                  <TableHead className="text-right">Finished</TableHead>
                  <TableHead className="text-right">Left</TableHead>
                  <TableHead>Changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drips.data.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/drips/${d.id}`} className="font-medium hover:underline">
                        {d.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={DRIP_STATUS_VARIANT[d.status]}>{DRIP_STATUS_LABEL[d.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.number.label}</TableCell>
                    <TableCell className="text-right">{d.steps}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.active)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.finished)}</TableCell>
                    <TableCell className="text-right">{formatNumber(d.left)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(d.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{drips.isLoading ? 'Loading…' : 'No drips yet. Create one to send a welcome series or reminders automatically.'}</p>
          )}
        </CardContent>
      </Card>
      {creating ? <NewDripDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewDripDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const [name, setName] = useState('');
  const [numberId, setNumberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');
  const create = useMutation({
    mutationFn: () => api<DripDetail>('/drips', { method: 'POST', json: { name: name.trim(), numberId } }),
    onSuccess: (drip) => router.push(`/drips/${drip.id}`),
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New drip</DialogTitle>
          <DialogDescription>You add the steps, waits and rules next. Nothing is sent until you activate it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="drip-name">Drip name</Label>
            <Input id="drip-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Welcome series" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="drip-number">Send from</Label>
            <NativeSelect id="drip-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">Choose a number…</option>
              {connected.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !numberId || create.isPending} onClick={() => create.mutate()}>
            Create drip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
