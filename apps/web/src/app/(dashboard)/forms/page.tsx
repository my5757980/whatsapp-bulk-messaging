'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { FORM_CATEGORIES, type FormCategory } from '@wbm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { FORM_CATEGORY_LABEL, formsKeys, type FormDetail, type FormSummary } from '@/lib/forms';

const STATUS_VARIANT = { DRAFT: 'outline', PUBLISHED: 'success', ARCHIVED: 'secondary' } as const;

/** WhatsApp Forms (feature 008 US7, FR-030): the list and a new form. */
export default function FormsPage() {
  return (
    <RequirePermission permission="forms.manage">
      <Forms />
    </RequirePermission>
  );
}

function Forms() {
  const forms = useQuery({ queryKey: formsKeys.list(), queryFn: () => api<{ items: FormSummary[] }>('/forms') });
  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Forms</h1>
          <p className="text-sm text-muted-foreground">WhatsApp Forms customers fill in without leaving the chat. Answers can fill contact attributes and add tags.</p>
        </div>
        <NewForm />
      </div>
      {forms.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {forms.isSuccess && !forms.data.items.length ? <p className="text-sm text-muted-foreground">No forms yet.</p> : null}
      {forms.data?.items.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="forms-table">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Form</th>
                <th className="p-2">Kind</th>
                <th className="p-2">Status</th>
                <th className="p-2">Version</th>
                <th className="p-2 text-right">Answers</th>
              </tr>
            </thead>
            <tbody>
              {forms.data.items.map((f) => (
                <tr key={f.id} className="border-t">
                  <td className="p-2">
                    <Link href={`/forms/${f.id}`} className="font-medium hover:underline">
                      {f.name}
                    </Link>
                  </td>
                  <td className="p-2">{FORM_CATEGORY_LABEL[f.category]}</td>
                  <td className="p-2">
                    <Badge variant={STATUS_VARIANT[f.status]}>{f.status.charAt(0) + f.status.slice(1).toLowerCase()}</Badge>
                    {f.status === 'PUBLISHED' && f.changedSincePublish ? (
                      <Badge variant="warning" className="ml-1">
                        Changes not published
                      </Badge>
                    ) : null}
                  </td>
                  <td className="p-2">{f.currentVersion ? `v${f.currentVersion}` : '—'}</td>
                  <td className="p-2 text-right">
                    <Link href={`/forms/${f.id}/answers`} className="hover:underline">
                      {f.answers}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function NewForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FormCategory>('SIGN_UP');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<FormDetail>('/forms', { method: 'POST', json: { name: name.trim(), category } }),
    onSuccess: (form) => router.push(`/forms/${form.id}`),
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New form</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>New form</DialogTitle>
            <DialogDescription>Meta uses the kind to show the form; you can change it before publishing.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="form-name">Form name</Label>
            <Input id="form-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="form-category">Kind</Label>
            <NativeSelect id="form-category" value={category} onChange={(e) => setCategory(e.target.value as FormCategory)}>
              {FORM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {FORM_CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create form
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
