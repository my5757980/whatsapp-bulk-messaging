'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WizardCheckList } from '@/components/integrations/wizard-checks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import type { WizardChecks } from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';

const QUALITY_VARIANT = { GREEN: 'success', YELLOW: 'warning', RED: 'destructive', UNKNOWN: 'outline' } as const;
const STATUS_VARIANT = { CONNECTED: 'success', ERROR: 'destructive', DISCONNECTED: 'outline' } as const;

/** Settings > WhatsApp numbers (T107). */
export default function NumbersPage() {
  const queryClient = useQueryClient();
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.numbers });

  const refresh = useMutation({
    mutationFn: (id: string) => api<WhatsAppNumber>(`/numbers/${id}/refresh`, { method: 'POST' }),
    onSuccess: (n) => {
      void invalidate();
      if (n.lastError) toast.warning(`${n.label}: ${n.lastError}`);
      else toast.success(`${n.label} refreshed`);
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">WhatsApp numbers</h1>
          <p className="text-sm text-muted-foreground">Numbers connected through the WhatsApp Cloud API. Access tokens are stored encrypted and never shown again.</p>
        </div>
        <Can permission="numbers.manage">
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/numbers/connect">Connect with checks</Link>
            </Button>
            <ConnectNumberDialog onConnected={invalidate} />
          </div>
        </Can>
      </div>

      <Card>
        <CardContent className="p-0">
          {numbers.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : numbers.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(numbers.error)}</p>
          ) : !numbers.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No numbers yet. Connect one to start sending.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Quality</TableHead>
                  <TableHead>Limit tier</TableHead>
                  <TableHead>Send rate</TableHead>
                  <TableHead>Sending</TableHead>
                  <TableHead>Last checked</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numbers.data.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <div className="font-medium">{n.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {n.displayPhoneNumber} · {n.verifiedName}
                      </div>
                      {n.lastError ? <div className="text-xs text-destructive">{n.lastError}</div> : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[n.connectionStatus]}>{n.connectionStatus.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={QUALITY_VARIANT[n.qualityRating]}>{n.qualityRating.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell>{n.messagingLimitTier ?? '—'}</TableCell>
                    <TableCell>{n.sendRatePerSecond}/s</TableCell>
                    <TableCell>
                      {n.sendingEnabled ? <Badge variant="success">on</Badge> : <Badge variant="destructive">off (kill switch)</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(n.lastSyncedAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => refresh.mutate(n.id)}
                          disabled={refresh.isPending && refresh.variables === n.id}
                          aria-label={`Refresh ${n.label}`}
                        >
                          <RefreshCw className="h-3.5 w-3.5" /> Refresh
                        </Button>
                        <Can permission="numbers.manage">
                          <HealthCheckDialog number={n} />
                          <EditNumberDialog number={n} onSaved={invalidate} />
                          {n.connectionStatus !== 'DISCONNECTED' ? (
                            <ConfirmDialog
                              trigger={
                                <Button variant="ghost" size="sm" className="text-destructive">
                                  Disconnect
                                </Button>
                              }
                              title={`Disconnect ${n.label}?`}
                              description="Running campaigns on this number will be paused. You can reconnect later by entering a new access token."
                              confirmLabel="Disconnect"
                              confirmVariant="destructive"
                              onConfirm={() =>
                                api(`/numbers/${n.id}`, { method: 'DELETE' })
                                  .then(() => {
                                    toast.success(`${n.label} disconnected`);
                                    return invalidate();
                                  })
                                  .catch(toastError)
                              }
                            />
                          ) : null}
                        </Can>
                      </div>
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
          <CardTitle className="text-base">About send rate and the kill switch</CardTitle>
          <CardDescription>
            Meta allows up to 80 messages per second per number by default. The send rate here caps how fast campaigns go out. Turning sending off
            pauses every running campaign on the number within seconds.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function Field({ id, label, hint, ...props }: { id: string; label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ConnectNumberDialog({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: (body: Record<string, string>) => api<WhatsAppNumber>('/numbers', { method: 'POST', json: body }),
    onSuccess: (n) => {
      toast.success(`${n.label} connected`);
      setOpen(false);
      onConnected();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    connect.mutate(data);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Connect number</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a WhatsApp number</DialogTitle>
          <DialogDescription>Find these values in Meta Business Manager under WhatsApp Manager and your system user.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field id="label" name="label" label="Label" placeholder="Support line" required maxLength={60} />
          <Field id="wabaId" name="wabaId" label="WhatsApp Business Account ID" required />
          <Field id="phoneNumberId" name="phoneNumberId" label="Phone number ID" required />
          <Field id="accessToken" name="accessToken" label="Access token" type="password" autoComplete="off" required hint="Stored encrypted. It is never shown again." />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? 'Checking with Meta…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditNumberDialog({ number, onSaved }: { number: WhatsAppNumber; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingEnabled, setSendingEnabled] = useState(number.sendingEnabled);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<WhatsAppNumber>(`/numbers/${number.id}`, { method: 'PATCH', json: body }),
    onSuccess: () => {
      toast.success('Number updated');
      setOpen(false);
      onSaved();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const token = String(form.get('accessToken') ?? '').trim();
    const tier = String(form.get('messagingLimitTier') ?? '').trim();
    save.mutate({
      label: String(form.get('label') ?? '').trim(),
      sendRatePerSecond: Number(form.get('sendRatePerSecond')),
      sendingEnabled,
      messagingLimitTier: tier || null,
      ...(token ? { accessToken: token } : {}),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSendingEnabled(number.sendingEnabled);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {number.label}</DialogTitle>
          <DialogDescription>{number.displayPhoneNumber}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field id="edit-label" name="label" label="Label" defaultValue={number.label} required maxLength={60} />
          <Field id="edit-rate" name="sendRatePerSecond" label="Send rate (messages per second)" type="number" min={1} max={80} defaultValue={number.sendRatePerSecond} required />
          <Field id="edit-tier" name="messagingLimitTier" label="Messaging limit tier" placeholder="TIER_1K" defaultValue={number.messagingLimitTier ?? ''} hint="Optional. Used to warn before a campaign exceeds the 24-hour limit." />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={sendingEnabled} onChange={(e) => setSendingEnabled(e.target.checked)} />
            Sending enabled (turn off to stop all sending from this number)
          </label>
          <Field id="edit-token" name="accessToken" label="New access token" type="password" autoComplete="off" hint="Leave empty to keep the current token." />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The wizard's checks on a connected number, with its stored token; nothing is changed (006 FR-055). */
function HealthCheckDialog({ number }: { number: WhatsAppNumber }) {
  const [open, setOpen] = useState(false);
  const run = useMutation({ mutationFn: () => api<WizardChecks>(`/numbers/${number.id}/health-check`, { method: 'POST' }), onError: toastError });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) run.mutate();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Run checks on ${number.label}`}>
          Run checks
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Checks for {number.label}</DialogTitle>
          <DialogDescription>
            {run.isPending ? 'Checking with Meta…' : run.data ? (run.data.ready ? 'Nothing failed.' : 'Some checks failed; each shows how to fix it.') : 'The same checks as the connection wizard.'}
          </DialogDescription>
        </DialogHeader>
        {run.data ? <WizardCheckList checks={run.data.checks} /> : null}
        <DialogFooter>
          <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
            Run again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
