'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import type { FlowDetail } from '@/lib/flows';

export type FlowSecret = FlowDetail['secrets'][number];

/**
 * Secret values for API step headers (003 T060, FR-015): typed once, stored encrypted, then shown
 * only as •••• (the server never returns them). Steps refer to a secret, so a value can be replaced
 * without editing the flow.
 */
export function SecretsPanel({ flowId, secrets, onChange }: { flowId: string; secrets: FlowSecret[]; onChange: (next: FlowSecret[]) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const create = useMutation({
    mutationFn: () => api<FlowSecret>(`/flows/${flowId}/secrets`, { method: 'POST', json: { name: name.trim(), value } }),
    onSuccess: (secret) => {
      onChange([...secrets, secret]);
      setName('');
      setValue('');
      toast.success(`Secret "${secret.name}" saved`);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/flows/${flowId}/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => onChange(secrets.filter((s) => s.id !== id)),
    onError: toastError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && value) create.mutate();
  }

  return (
    <section aria-labelledby="secrets-title" className="grid gap-2 rounded-lg border bg-card p-3">
      <div>
        <h2 id="secrets-title" className="text-sm font-semibold">
          Secrets for API steps
        </h2>
        <p className="text-xs text-muted-foreground">Keys and tokens are stored encrypted and never shown again.</p>
      </div>
      {secrets.length > 0 && (
        <ul className="grid gap-1" data-testid="secrets">
          {secrets.map((secret) => (
            <li key={secret.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">
                {secret.name} <span className="text-muted-foreground">••••</span>
              </span>
              <Button type="button" size="sm" variant="ghost" aria-label={`Delete secret ${secret.name}`} onClick={() => remove.mutate(secret.id)} disabled={remove.isPending}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="grid gap-2">
        <div className="grid gap-1">
          <Label htmlFor="secret-name">Secret name</Label>
          <Input id="secret-name" value={name} maxLength={60} placeholder="e.g. Shop token" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="secret-value">Secret value</Label>
          <Input id="secret-value" type="password" autoComplete="off" value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
        </div>
        <Button type="submit" size="sm" variant="outline" className="justify-self-start" disabled={!name.trim() || !value || create.isPending}>
          Save secret
        </Button>
      </form>
    </section>
  );
}
