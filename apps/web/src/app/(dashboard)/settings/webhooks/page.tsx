'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventType } from '@wbm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { EndpointStatusBadge, EventPicker, SecretOnce } from '@/components/integrations/webhook-parts';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { integrationsKeys, type WebhookEndpoint, type WebhookEndpointWithSecret } from '@/lib/integrations';

/** Settings > Webhooks (feature 006 US1, T025): endpoints that receive platform events. Admins only. */
export default function WebhooksPage() {
  return (
    <RequirePermission permission="integrations.manage">
      <Webhooks />
    </RequirePermission>
  );
}

function Webhooks() {
  const endpoints = useQuery({ queryKey: integrationsKeys.endpoints, queryFn: () => api<WebhookEndpoint[]>('/webhook-endpoints') });

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">Send platform events to your CRM, Zapier, Make, Pabbly, n8n or your own software, signed so they can be checked.</p>
        </div>
        <AddEndpointDialog />
      </div>
      <Card>
        <CardContent className="p-0">
          {endpoints.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : endpoints.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(endpoints.error)}</p>
          ) : !endpoints.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No endpoints yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Waiting</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.data.map((e) => (
                  <TableRow key={e.id} data-testid="endpoint-row">
                    <TableCell className="font-medium">
                      <Link href={`/settings/webhooks/${e.id}`} className="underline-offset-2 hover:underline">
                        {e.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-64 truncate font-mono text-xs">{e.url}</TableCell>
                    <TableCell>{e.eventTypes.length}</TableCell>
                    <TableCell>{e.waiting ?? 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(e.lastSuccessAt)}</TableCell>
                    <TableCell>
                      <EndpointStatusBadge status={e.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How deliveries work</CardTitle>
          <CardDescription>
            Each event is posted as JSON with <code className="font-mono">webhook-id</code>, <code className="font-mono">webhook-timestamp</code> and{' '}
            <code className="font-mono">webhook-signature</code> headers. A 2xx answer within 10 seconds counts as delivered; otherwise the platform tries
            again for about a day. Ignore repeated ids, and order events by their time.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function AddEndpointDialog() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<WebhookEndpointWithSecret | null>(null);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [includeContent, setIncludeContent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { name: string; url: string; eventTypes: EventType[]; includeContent: boolean }) =>
      api<WebhookEndpointWithSecret>('/webhook-endpoints', { method: 'POST', json: body }),
    onSuccess: (endpoint) => {
      setCreated(endpoint);
      void queryClient.invalidateQueries({ queryKey: integrationsKeys.endpoints });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    if (!eventTypes.length) {
      setError('Choose at least one event');
      return;
    }
    create.mutate({ name: String(form.get('name') ?? '').trim(), url: String(form.get('url') ?? '').trim(), eventTypes, includeContent });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCreated(null);
          setError(null);
          setEventTypes([]);
          setIncludeContent(true);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Add endpoint</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{created ? 'Copy the signing secret now' : 'Add a webhook endpoint'}</DialogTitle>
          <DialogDescription>{created ? 'For security it is shown only once.' : 'Events go to this address as they happen.'}</DialogDescription>
        </DialogHeader>
        {created ? (
          <SecretOnce
            secret={created.secret}
            onDone={() => {
              setOpen(false);
              router.push(`/settings/webhooks/${created.id}`);
            }}
          />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="endpoint-name">Name</Label>
              <Input id="endpoint-name" name="name" required maxLength={80} placeholder="CRM" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="endpoint-url">Address</Label>
              <Input id="endpoint-url" name="url" required maxLength={2000} placeholder="https://crm.example.com/hooks/whatsapp" />
            </div>
            <EventPicker value={eventTypes} onChange={setEventTypes} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={includeContent} onChange={(e) => setIncludeContent(e.target.checked)} />
              Include the text of customer messages
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                Save endpoint
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
