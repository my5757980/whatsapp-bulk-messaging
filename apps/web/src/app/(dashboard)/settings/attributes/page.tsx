'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { titleCase } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, AttributeType, Tag } from '@/lib/types';

/** Settings > Attributes & tags (T130). */
export default function AttributesAndTagsPage() {
  return (
    <div className="grid max-w-4xl gap-6">
      <AttributesCard />
      <TagsCard />
    </div>
  );
}

function AttributesCard() {
  const queryClient = useQueryClient();
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.attributes });
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<AttributeType>('TEXT');
  const create = useMutation({
    mutationFn: (body: Record<string, string>) => api<AttributeDefinition>('/attributes', { method: 'POST', json: body }),
    onSuccess: (a) => {
      toast.success(`Attribute ${a.key} created`);
      void invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    create.mutate({ key: String(form.get('key') ?? '').trim(), label: String(form.get('label') ?? '').trim(), type });
    event.currentTarget.reset();
  }

  async function rename(a: AttributeDefinition) {
    const label = window.prompt(`New label for ${a.key}`, a.label)?.trim();
    if (!label || label === a.label) return;
    await api(`/attributes/${a.id}`, { method: 'PATCH', json: { label } }).then(invalidate).catch(toastError);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom attributes</CardTitle>
        <CardDescription>Typed fields on every contact, usable in filters and template variables. The key and type cannot change later.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(attributes.data ?? []).map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">{a.key}</TableCell>
                <TableCell>{a.label}</TableCell>
                <TableCell>{titleCase(a.type)}</TableCell>
                <TableCell className="text-right">
                  <Can permission="attributes.manage">
                    <Button variant="ghost" size="sm" onClick={() => void rename(a)}>
                      Rename
                    </Button>
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="sm" className="text-destructive">
                          Delete
                        </Button>
                      }
                      title={`Delete attribute ${a.key}?`}
                      description="Its value is removed from every contact. Filters and campaign mappings that use it stop working."
                      confirmLabel="Delete attribute"
                      confirmVariant="destructive"
                      onConfirm={() => api(`/attributes/${a.id}`, { method: 'DELETE' }).then(invalidate).catch(toastError)}
                    />
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {attributes.isSuccess && !attributes.data.length ? <p className="text-sm text-muted-foreground">No custom attributes yet.</p> : null}
        <Can permission="attributes.manage">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="attr-key">Key</Label>
              <Input id="attr-key" name="key" required pattern="[a-z][a-z0-9_]{0,39}" placeholder="last_order_date" className="w-48" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="attr-label">Label</Label>
              <Input id="attr-label" name="label" required maxLength={60} placeholder="Last order date" className="w-48" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="attr-type">Type</Label>
              <NativeSelect id="attr-type" className="w-36" value={type} onChange={(e) => setType(e.target.value as AttributeType)}>
                <option value="TEXT">Text</option>
                <option value="NUMBER">Number</option>
                <option value="DATE">Date</option>
                <option value="BOOLEAN">Yes / no</option>
              </NativeSelect>
            </div>
            <Button type="submit" disabled={create.isPending}>
              Add attribute
            </Button>
          </form>
        </Can>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TagsCard() {
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.tags });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<Tag>('/tags', { method: 'POST', json: { name } }),
    onSuccess: () => {
      setName('');
      void invalidate();
    },
    onError: toastError,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tags</CardTitle>
        <CardDescription>Labels for grouping contacts. Names are case-insensitive.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          {(tags.data ?? []).map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm">
              {t.name} <span className="text-xs text-muted-foreground">({t.contactCount})</span>
              <Can permission="contacts.manage">
                <ConfirmDialog
                  trigger={
                    <button type="button" className="ml-1 text-muted-foreground hover:text-destructive" aria-label={`Delete tag ${t.name}`}>
                      ×
                    </button>
                  }
                  title={`Delete tag "${t.name}"?`}
                  description={`It is removed from ${t.contactCount} contacts. The contacts themselves are kept.`}
                  confirmLabel="Delete tag"
                  confirmVariant="destructive"
                  onConfirm={() => api(`/tags/${t.id}`, { method: 'DELETE' }).then(invalidate).catch(toastError)}
                />
              </Can>
            </span>
          ))}
          {tags.isSuccess && !tags.data.length ? <p className="text-sm text-muted-foreground">No tags yet.</p> : null}
        </div>
        <Can permission="contacts.manage">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="tag-name">New tag</Label>
              <Input id="tag-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} className="w-48" />
            </div>
            <Button type="submit" variant="secondary" disabled={create.isPending}>
              Add tag
            </Button>
          </form>
        </Can>
      </CardContent>
    </Card>
  );
}
