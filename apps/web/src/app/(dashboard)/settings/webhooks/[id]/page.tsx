'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_LABELS, isEventType, type EventType } from '@wbm/shared';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EndpointStatusBadge, EventPicker, SecretOnce } from '@/components/integrations/webhook-parts';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  DELIVERY_ERROR_LABEL,
  DELIVERY_STATUS_LABEL,
  integrationsKeys,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEndpointWithSecret,
  type WebhookTestResult,
} from '@/lib/integrations';

const PAGE_SIZE = 50;

/** One webhook endpoint: settings, test event, pause and resume, secret renewal and the delivery log (feature 006 US1, T025). */
export default function WebhookEndpointPage() {
  return (
    <RequirePermission permission="integrations.manage">
      <Endpoint />
    </RequirePermission>
  );
}

function Endpoint() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const endpoint = useQuery({ queryKey: integrationsKeys.endpoint(id), queryFn: () => api<WebhookEndpoint>(`/webhook-endpoints/${id}`) });
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [page, setPage] = useState(1);
  const deliveries = useQuery({
    queryKey: integrationsKeys.deliveries(id, page, status || undefined),
    queryFn: () => api<{ items: WebhookDelivery[]; total: number }>(`/webhook-endpoints/${id}/deliveries?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}`),
    refetchInterval: 10_000,
  });
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: integrationsKeys.endpoint(id) }), queryClient.invalidateQueries({ queryKey: ['webhook-endpoints', id, 'deliveries'] })]);

  const action = useMutation({
    mutationFn: (path: 'pause' | 'resume') => api<WebhookEndpoint>(`/webhook-endpoints/${id}/${path}`, { method: 'POST' }),
    onSuccess: () => void refresh(),
    onError: toastError,
  });
  const test = useMutation({
    mutationFn: () => api<WebhookTestResult>(`/webhook-endpoints/${id}/test`, { method: 'POST' }),
    onSuccess: (result) => {
      setTestResult(result);
      void refresh();
    },
    onError: toastError,
  });
  const renew = useMutation({
    mutationFn: () => api<WebhookEndpointWithSecret>(`/webhook-endpoints/${id}/renew-secret`, { method: 'POST' }),
    onSuccess: (e) => setSecret(e.secret),
    onError: toastError,
  });

  if (endpoint.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (endpoint.error || !endpoint.data) return <p className="text-sm text-destructive">{errorMessage(endpoint.error)}</p>;
  const e = endpoint.data;
  const pages = Math.max(1, Math.ceil((deliveries.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{e.name}</h2>
            <EndpointStatusBadge status={e.status} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">{e.url}</p>
          {e.status === 'FAILING' ? (
            <p className="text-sm text-destructive">No successful delivery for 24 hours, so deliveries stopped. Fix the receiver, then resume: waiting events go at once.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
            Send test event
          </Button>
          {e.status === 'ACTIVE' ? (
            <Button variant="outline" onClick={() => action.mutate('pause')} disabled={action.isPending}>
              Pause
            </Button>
          ) : (
            <Button variant="outline" onClick={() => action.mutate('resume')} disabled={action.isPending}>
              Resume
            </Button>
          )}
          <ConfirmDialog
            trigger={<Button variant="outline">Renew secret</Button>}
            title="Make a new signing secret?"
            description="For 24 hours events carry signatures for both the old and the new secret, so your receiver can switch without missing any."
            confirmLabel="Make new secret"
            onConfirm={() => renew.mutateAsync().then(() => undefined, () => undefined)}
          />
          <ConfirmDialog
            trigger={
              <Button variant="ghost" className="text-destructive">
                Delete
              </Button>
            }
            title={`Delete "${e.name}"?`}
            description="Waiting events for it are dropped and its delivery log is removed."
            confirmLabel="Delete endpoint"
            confirmVariant="destructive"
            onConfirm={() =>
              api(`/webhook-endpoints/${id}`, { method: 'DELETE' })
                .then(() => {
                  toast.success('Endpoint deleted');
                  router.push('/settings/webhooks');
                })
                .catch(toastError)
            }
          />
        </div>
      </div>

      {testResult ? (
        <Card>
          <CardContent className="p-4 text-sm" data-testid="test-result">
            {testResult.ok ? 'Test event delivered' : 'Test event failed'}: {testResult.statusCode ?? 'no answer'}
            {testResult.error ? ` (${DELIVERY_ERROR_LABEL[testResult.error]})` : ''} in {testResult.durationMs} ms
          </CardContent>
        </Card>
      ) : null}

      <EndpointSettings endpoint={e} onSaved={() => void refresh()} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Delivery log (30 days)</CardTitle>
          <NativeSelect
            aria-label="Delivery status"
            value={status}
            onChange={(ev) => {
              setStatus(ev.target.value as DeliveryStatus | '');
              setPage(1);
            }}
          >
            <option value="">All</option>
            {(Object.keys(DELIVERY_STATUS_LABEL) as DeliveryStatus[]).map((s) => (
              <option key={s} value={s}>
                {DELIVERY_STATUS_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </CardHeader>
        <CardContent className="p-0">
          {!deliveries.data?.items.length ? (
            <p className="p-6 text-sm text-muted-foreground">{deliveries.isLoading ? 'Loading…' : 'No deliveries yet.'}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Answer</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.items.map((d) => (
                  <TableRow key={d.id} data-testid="delivery-row">
                    <TableCell>
                      <div className="text-sm">{isEventType(d.type) ? EVENT_LABELS[d.type] : d.type}</div>
                      <div className="font-mono text-xs text-muted-foreground">{d.eventId}</div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={d.status === 'DELIVERED' ? 'success' : d.status === 'FAILED' ? 'destructive' : 'outline'}>{DELIVERY_STATUS_LABEL[d.status]}</Badge>
                      {d.status === 'PENDING' && d.nextAttemptAt ? <div className="text-xs text-muted-foreground">next {formatDateTime(d.nextAttemptAt)}</div> : null}
                    </TableCell>
                    <TableCell>{d.attempts}</TableCell>
                    <TableCell className="text-xs">
                      {d.lastStatusCode ?? '—'}
                      {d.lastError ? <div className="text-muted-foreground">{DELIVERY_ERROR_LABEL[d.lastError]}</div> : null}
                      {d.lastDurationMs !== null ? <div className="text-muted-foreground">{d.lastDurationMs} ms</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.status === 'FAILED' || d.status === 'DELIVERED' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            api(`/webhook-deliveries/${d.id}/resend`, { method: 'POST' })
                              .then(() => {
                                toast.success('Sent again');
                                return refresh();
                              })
                              .catch(toastError)
                          }
                        >
                          Send again
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {pages > 1 ? (
            <div className="flex items-center gap-2 p-4 text-sm">
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
        </CardContent>
      </Card>

      <Dialog open={secret !== null} onOpenChange={(open) => (!open ? setSecret(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy the new signing secret now</DialogTitle>
            <DialogDescription>For security it is shown only once.</DialogDescription>
          </DialogHeader>
          {secret ? <SecretOnce secret={secret} onDone={() => setSecret(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EndpointSettings({ endpoint, onSaved }: { endpoint: WebhookEndpoint; onSaved: () => void }) {
  const [name, setName] = useState(endpoint.name);
  const [url, setUrl] = useState(endpoint.url);
  const [eventTypes, setEventTypes] = useState<EventType[]>(endpoint.eventTypes);
  const [includeContent, setIncludeContent] = useState(endpoint.includeContent);
  useEffect(() => {
    setName(endpoint.name);
    setUrl(endpoint.url);
    setEventTypes(endpoint.eventTypes);
    setIncludeContent(endpoint.includeContent);
  }, [endpoint]);
  const save = useMutation({
    mutationFn: () => api<WebhookEndpoint>(`/webhook-endpoints/${endpoint.id}`, { method: 'PATCH', json: { name, url, eventTypes, includeContent } }),
    onSuccess: () => {
      toast.success('Endpoint saved');
      onSaved();
    },
    onError: toastError,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-url">Address</Label>
            <Input id="edit-url" value={url} maxLength={2000} onChange={(ev) => setUrl(ev.target.value)} />
          </div>
        </div>
        <EventPicker value={eventTypes} onChange={setEventTypes} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={includeContent} onChange={(ev) => setIncludeContent(ev.target.checked)} />
          Include the text of customer messages
        </label>
        <div>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !eventTypes.length || !name.trim() || !url.trim()}>
            Save settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
