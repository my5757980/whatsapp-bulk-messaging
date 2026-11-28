'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { GLOBAL_USAGE_LABELS, globalAttributesKey, globalPlaceholder, useGlobalAttributes, type GlobalAttribute, type GlobalUsageKind } from '@/lib/global-attributes';
import { Can } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';

// Feature 010 (US3, FR-014 – FR-016): company-wide values for campaign variables, chat replies, flow
// messages and AI agent instructions.

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const TEXTAREA = 'min-h-[64px] w-full rounded-md border bg-background px-3 py-2 text-sm';

/** "Still used by: Saved reply "Hours", Flow "Menu"" from a GLOBAL_ATTRIBUTE_IN_USE refusal. */
function inUseText(error: unknown): string {
  if (!(error instanceof ApiError) || error.code !== 'GLOBAL_ATTRIBUTE_IN_USE') return errorMessage(error);
  const users = (error.details ?? []).map((d) => {
    const kind = d.field.split('.')[0]!.toUpperCase() as GlobalUsageKind;
    return `${GLOBAL_USAGE_LABELS[kind] ?? kind} "${d.issue}"`;
  });
  return `It is still used by: ${users.join(', ')}. Remove it there first.`;
}

export default function GlobalAttributesPage() {
  return (
    <RequirePermission permission="contacts.view">
      <GlobalAttributes />
    </RequirePermission>
  );
}

function GlobalAttributes() {
  const globals = useGlobalAttributes();
  const items = globals.data?.items ?? [];
  return (
    <div className="grid max-w-3xl gap-6">
      <div>
        <h2 className="text-lg font-semibold">Global attributes</h2>
        <p className="text-sm text-muted-foreground">
          Company-wide values such as opening hours or a support number. Map them to template variables, or write {'{global:name}'} in saved replies, flow
          messages and AI agent instructions. Messages use the value in force when they are made.
        </p>
      </div>
      <Can permission="settings.manage">
        <AddGlobalAttribute />
      </Can>
      <Card>
        <CardContent className="grid gap-2 p-4 text-sm">
          {globals.isLoading ? <p className="text-muted-foreground">Loading…</p> : null}
          {!globals.isLoading && !items.length ? <p className="text-muted-foreground">No global attributes yet.</p> : null}
          {items.map((g) => (
            <GlobalAttributeRow key={g.id} attribute={g} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AddGlobalAttribute() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (body: { key: string; description: string | null; value: string }) => api<GlobalAttribute>('/global-attributes', { method: 'POST', json: body }),
    onSuccess: async () => {
      setError(null);
      toast.success('Global attribute added');
      await queryClient.invalidateQueries({ queryKey: globalAttributesKey });
    },
    onError: (e) => setError(e instanceof ApiError && e.code === 'KEY_TAKEN' ? 'Another global attribute has this name.' : errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = String(data.get('key') ?? '').trim();
    if (!KEY_PATTERN.test(key)) {
      setError('Use lower-case letters, digits and _, starting with a letter (40 at most).');
      return;
    }
    const description = String(data.get('description') ?? '').trim();
    add.mutate({ key, description: description || null, value: String(data.get('value') ?? '') }, { onSuccess: () => form.reset() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a global attribute</CardTitle>
        <CardDescription>The name cannot change later; the description and value can.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="global-key">Name</Label>
              <Input id="global-key" name="key" maxLength={40} placeholder="store_hours" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="global-description">Description (optional)</Label>
              <Input id="global-description" name="description" maxLength={200} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="global-value">Value</Label>
            <textarea id="global-value" name="value" maxLength={1024} className={TEXTAREA} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={add.isPending}>
              Add
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function GlobalAttributeRow({ attribute }: { attribute: GlobalAttribute }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(attribute.value);
  const [description, setDescription] = useState(attribute.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: globalAttributesKey });
  const save = useMutation({
    mutationFn: () => api<GlobalAttribute>(`/global-attributes/${attribute.id}`, { method: 'PUT', json: { description: description.trim() || null, value } }),
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      toast.success('Global attribute saved');
      await refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/global-attributes/${attribute.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setError(null);
      toast.success('Global attribute deleted');
      await refresh();
    },
    onError: (e) => setError(inUseText(e)),
  });

  return (
    <div className="grid gap-2 rounded-md border p-3" data-testid="global-attribute">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="font-mono text-sm font-medium">{globalPlaceholder(attribute.key)}</span>
          {attribute.description ? <span className="text-xs text-muted-foreground">{attribute.description}</span> : null}
        </div>
        <Can permission="settings.manage">
          {!editing ? (
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setValue(attribute.value);
                  setDescription(attribute.description ?? '');
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete
              </Button>
            </span>
          ) : null}
        </Can>
      </div>
      {editing ? (
        <div className="grid gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`global-${attribute.id}-description`}>Description</Label>
            <Input id={`global-${attribute.id}-description`} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`global-${attribute.id}-value`}>Value</Label>
            <textarea id={`global-${attribute.id}-value`} value={value} maxLength={1024} className={TEXTAREA} onChange={(e) => setValue(e.target.value)} />
          </div>
          <span className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </span>
        </div>
      ) : (
        <p className="whitespace-pre-wrap" data-testid="global-attribute-value">
          {attribute.value.trim() ? attribute.value : <span className="text-muted-foreground">No value yet — campaigns that map it cannot launch.</span>}
        </p>
      )}
      <span className="text-xs text-muted-foreground">
        Changed {formatDateTime(attribute.updatedAt)}
        {attribute.updatedBy ? ` by ${attribute.updatedBy}` : ''}
      </span>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
