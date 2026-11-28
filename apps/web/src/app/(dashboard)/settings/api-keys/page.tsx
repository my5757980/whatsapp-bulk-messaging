'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_SCOPES, SCOPE_LABELS, type ApiKeyScope } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
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

interface ApiKeyRow {
  id: string;
  name: string;
  last4: string;
  rateLimitPerMinute: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** What the key may do (feature 006). */
  scopes: ApiKeyScope[];
}

/** Settings > API keys (T192): create (secret shown once), list, set permissions (006 T033) and revoke. */
export default function ApiKeysPage() {
  return (
    <RequirePermission permission="apikeys.manage">
      <ApiKeys />
    </RequirePermission>
  );
}

function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKeyRow[]>('/api-keys') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['api-keys'] });

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="text-sm text-muted-foreground">Keys let your website, CRM or billing system send approved templates and manage contacts through the API.</p>
        </div>
        <CreateKeyDialog onCreated={invalidate} />
      </div>
      <Card>
        <CardContent className="p-0">
          {keys.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : keys.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(keys.error)}</p>
          ) : !keys.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Limit</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((k) => (
                  <TableRow key={k.id} data-testid="api-key-row">
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">wbk_••••{k.last4}</TableCell>
                    <TableCell>{k.rateLimitPerMinute}/min</TableCell>
                    <TableCell className="text-xs">
                      <ul className="grid gap-0.5">
                        {k.scopes.map((s) => (
                          <li key={s}>{SCOPE_LABELS[s]}</li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(k.createdAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(k.lastUsedAt)}</TableCell>
                    <TableCell>{k.revokedAt ? <Badge variant="outline">Revoked</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                    <TableCell className="text-right">
                      {!k.revokedAt ? <PermissionsDialog keyRow={k} onSaved={invalidate} /> : null}
                      {!k.revokedAt ? (
                        <ConfirmDialog
                          trigger={
                            <Button variant="ghost" size="sm" className="text-destructive">
                              Revoke
                            </Button>
                          }
                          title={`Revoke "${k.name}"?`}
                          description="Systems using this key stop working immediately. This cannot be undone; create a new key instead."
                          confirmLabel="Revoke key"
                          confirmVariant="destructive"
                          onConfirm={() =>
                            api(`/api-keys/${k.id}`, { method: 'DELETE' })
                              .then(() => {
                                toast.success('Key revoked');
                                return invalidate();
                              })
                              .catch(toastError)
                          }
                        />
                      ) : null}
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
          <CardTitle className="text-base">Using the API</CardTitle>
          <CardDescription>
            Send <code className="font-mono">POST /api/v1/messages</code> with <code className="font-mono">Authorization: Bearer wbk_…</code>. Add an{' '}
            <code className="font-mono">Idempotency-Key</code> header so retries never send twice. Opted-out contacts are always refused. With more permissions a key can also manage contacts, tags and consent under{' '}
            <code className="font-mono">/api/v1/contacts</code>, and add contacts to drips.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

/** Plain descriptions of each permission (feature 006, T033). */
const SCOPE_HELP: Record<ApiKeyScope, string> = {
  'messages.send': 'Send approved templates and read the template list',
  'contacts.read': 'Look contacts up, list them for syncing, and list tags and attributes',
  'contacts.write': 'Create and update contacts, add and remove tags, and record opt-ins (with a source note) and opt-outs',
  'campaigns.trigger': 'Send the template of a live API campaign to one phone number',
  'drips.enrol': 'Add a contact to an active drip by its name or id, or take them out of it',
  // Feature 008 (contracts/public-payments-v1.openapi.yaml)
  'payments.read': 'Read payment requests by id, reference or phone number',
  'payments.write': 'Make and send payment requests, and cancel waiting ones',
  // Feature 009 (contracts/public-otp-v1.openapi.yaml)
  'otp.send': 'Send one-time codes your website or app makes, with an approved code template, and read their status',
};

function PermissionsDialog({ keyRow, onSaved }: { keyRow: ApiKeyRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<ApiKeyScope>>(new Set(keyRow.scopes));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (scopes: ApiKeyScope[]) => api<{ id: string; scopes: ApiKeyScope[] }>(`/api-keys/${keyRow.id}/scopes`, { method: 'PUT', json: { scopes } }),
    onSuccess: () => {
      toast.success('Permissions saved');
      setOpen(false);
      onSaved();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = (scope: ApiKeyScope, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(scope);
    else next.delete(scope);
    setChosen(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setChosen(new Set(keyRow.scopes));
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Permissions
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What can “{keyRow.name}” do?</DialogTitle>
          <DialogDescription>
            Older keys can only send messages until you give them more. Systems using this key get the change on their next request.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-3">
          <legend className="sr-only">Permissions</legend>
          {API_KEY_SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={chosen.has(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
              <span className="grid gap-0.5">
                <span>{SCOPE_LABELS[scope]}</span>
                <span className="text-xs text-muted-foreground">{SCOPE_HELP[scope]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {chosen.size === 0 ? <p className="text-sm text-muted-foreground">Choose at least one permission, or revoke the key instead.</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={save.isPending || chosen.size === 0} onClick={() => save.mutate(API_KEY_SCOPES.filter((s) => chosen.has(s)))}>
            {save.isPending ? 'Saving…' : 'Save permissions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: { name: string; rateLimitPerMinute: number }) => api<ApiKeyRow & { secret: string }>('/api-keys', { method: 'POST', json: body }),
    onSuccess: (k) => {
      setSecret(k.secret);
      onCreated();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    create.mutate({ name: String(form.get('name') ?? '').trim(), rateLimitPerMinute: Number(form.get('rate') ?? 60) });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSecret(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Create API key</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? 'Copy your new key now' : 'Create an API key'}</DialogTitle>
          <DialogDescription>{secret ? 'For security it is shown only once. Store it in your system’s secret settings.' : 'Name it after the system that will use it.'}</DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="grid gap-3">
            <Label htmlFor="new-key-secret">API key</Label>
            <div className="flex gap-2">
              <Input id="new-key-secret" readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(secret)
                    .then(() => toast.success('Key copied'))
                    .catch(() => toast.error('Copy failed; select the key and copy it'))
                }
              >
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>I have stored it</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" name="name" required maxLength={60} placeholder="Website checkout" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="key-rate">Requests per minute</Label>
              <Input id="key-rate" name="rate" type="number" min={1} max={6000} defaultValue={60} required />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
