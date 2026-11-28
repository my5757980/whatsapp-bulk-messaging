'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { LEFT_REASON_LABEL, growthKeys, type EnrolResult, type Enrolment, type EnrolmentStatus } from '@/lib/growth';
import { Can } from '@/lib/permissions';
import { contacts010Keys, type BulkAction, type Segment } from '@/lib/contacts-010';

const PAGE_SIZE = 50;

export function enrolmentState(e: Enrolment): string {
  if (e.status === 'ACTIVE') return `Waiting for step ${e.currentPosition}`;
  if (e.status === 'FINISHED') return 'Finished';
  return `Left: ${(e.leftReason ? LEFT_REASON_LABEL[e.leftReason] : 'left').toLowerCase()}`;
}

/** The contacts in a drip, now and before (feature 005 US4, FR-025 - FR-028), with removal by a member. */
export function DripEnrolments({
  dripId,
  active,
  enrolling,
  onEnrollingChange,
}: {
  dripId: string;
  active: boolean;
  enrolling: boolean;
  onEnrollingChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | EnrolmentStatus>('');
  const [page, setPage] = useState(1);
  const enrolments = useQuery({
    queryKey: growthKeys.enrolments(dripId, page, status || undefined),
    queryFn: () => api<{ items: Enrolment[]; total: number }>(`/drips/${dripId}/enrolments?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}`),
    refetchInterval: active ? 10_000 : false,
  });
  const pages = Math.max(1, Math.ceil((enrolments.data?.total ?? 0) / PAGE_SIZE));
  const refresh = () => queryClient.invalidateQueries({ queryKey: growthKeys.drip(dripId) });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="enrolment-status">Show</Label>
          <NativeSelect
            id="enrolment-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | EnrolmentStatus);
              setPage(1);
            }}
          >
            <option value="">Everyone</option>
            <option value="ACTIVE">In the drip now</option>
            <option value="FINISHED">Finished</option>
            <option value="LEFT">Left</option>
          </NativeSelect>
        </div>
      </div>
      {enrolments.data?.items.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Where they are</TableHead>
              <TableHead>Next step</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrolments.data.items.map((e) => (
              <TableRow key={e.id} data-testid="enrolment-row">
                <TableCell>{e.contact.name ?? (e.contact.id ? 'No name' : 'Deleted contact')}</TableCell>
                <TableCell className="text-muted-foreground">{e.contact.phone ?? '—'}</TableCell>
                <TableCell>{enrolmentState(e)}</TableCell>
                <TableCell>{e.nextDueAt ? formatDateTime(e.nextDueAt) : '—'}</TableCell>
                <TableCell>{formatDateTime(e.joinedAt)}</TableCell>
                <TableCell className="text-right">
                  {e.status === 'ACTIVE' ? (
                    <Can permission="campaigns.launch">
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm">
                            Remove
                          </Button>
                        }
                        title="Remove this contact from the drip?"
                        description="They get no further steps. They can join again only if the drip allows it."
                        confirmLabel="Remove"
                        onConfirm={() =>
                          api(`/drips/${dripId}/enrolments/${e.id}`, { method: 'DELETE' })
                            .then(async () => {
                              toast.success('Removed from the drip');
                              await enrolments.refetch();
                              await refresh();
                            })
                            .catch(toastError)
                        }
                      />
                    </Can>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{enrolments.isLoading ? 'Loading…' : 'Nobody here yet.'}</p>
      )}
      {pages > 1 ? (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
      {enrolling && active ? (
        <EnrolDialog
          dripId={dripId}
          onClose={() => onEnrollingChange(false)}
          onDone={async () => {
            onEnrollingChange(false);
            await enrolments.refetch();
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Enrol contacts by hand (FR-025): everyone with a tag, with the counts before anyone joins. */
function EnrolDialog({ dripId, onClose, onDone }: { dripId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [tag, setTag] = useState('');
  // Feature 010 (FR-005): or a saved segment, enrolled in the background.
  const [segmentId, setSegmentId] = useState('');
  const segments = useQuery({ queryKey: contacts010Keys.segments, queryFn: () => api<{ items: Segment[] }>('/segments') });
  const [preview, setPreview] = useState<EnrolResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = () => (segmentId ? { segmentId } : { filter: { all: [{ tag: tag.trim().toLowerCase() }] } });
  const check = useMutation({
    mutationFn: () => api<EnrolResult>(`/drips/${dripId}/enrolments/preview`, { method: 'POST', json: input() }),
    onSuccess: (result) => {
      setPreview(result);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const enrol = useMutation({
    mutationFn: () => api<EnrolResult | BulkAction>(`/drips/${dripId}/enrolments`, { method: 'POST', json: input() }),
    onSuccess: async (result) => {
      toast.success('enrolled' in result ? `${formatNumber(result.enrolled)} joined the drip` : 'The segment is being enrolled in the background');
      await onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol contacts</DialogTitle>
          <DialogDescription>Contacts who opted out, are blocked or are already in the drip are left out.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="enrol-tag">Contacts with the tag</Label>
            <div className="flex gap-2">
              <Input
                id="enrol-tag"
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  setPreview(null);
                }}
                placeholder="new-lead"
              />
              <Button variant="outline" disabled={(!tag.trim() && !segmentId) || check.isPending} onClick={() => check.mutate()}>
                Check
              </Button>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="enrol-segment">Or everyone in a segment</Label>
            <NativeSelect
              id="enrol-segment"
              value={segmentId}
              onChange={(e) => {
                setSegmentId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">No segment</option>
              {(segments.data?.items ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {preview ? (
            <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="enrol-preview">
              <div className="font-medium">{formatNumber(preview.enrolled)} will join</div>
              <div className="text-muted-foreground">
                {formatNumber(preview.skippedOptedOut)} opted out or blocked · {formatNumber(preview.skippedAlreadyIn)} already in the drip
              </div>
            </div>
          ) : null}
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
          <Button disabled={!preview?.enrolled || enrol.isPending} onClick={() => enrol.mutate()}>
            Enrol
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
