'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
}

/** Settings > API keys (T192): create (secret shown once), list and revoke. */
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
          <p className="text-sm text-muted-foreground">Keys let your website, CRM or billing system send approved templates through the API.</p>
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
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(k.createdAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(k.lastUsedAt)}</TableCell>
                    <TableCell>{k.revokedAt ? <Badge variant="outline">Revoked</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                    <TableCell className="text-right">
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
            <code className="font-mono">Idempotency-Key</code> header so retries never send twice. Opted-out contacts are always refused.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
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
