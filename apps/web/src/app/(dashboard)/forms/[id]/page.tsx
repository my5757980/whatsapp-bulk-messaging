'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FORM_CATEGORIES, FORM_CHOICE_TYPES, FORM_FIELD_TYPES, type FormCategory, type FormField, type FormFieldType, type FormModel } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { FORM_CATEGORY_LABEL, FORM_FIELD_LABEL, formsKeys, type FormDetail, type FormProblem, type FormVersion } from '@/lib/forms';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Tag } from '@/lib/types';

type Screen = FormModel['screens'][number];

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'option';

/** The form builder (feature 008 US7, FR-030 – FR-032): screens, fields, mapping, tags, check, publish, versions. */
export default function FormBuilderPage() {
  return (
    <RequirePermission permission="forms.manage">
      <Builder />
    </RequirePermission>
  );
}

function Builder() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const form = useQuery({ queryKey: formsKeys.form(id), queryFn: () => api<FormDetail>(`/forms/${id}`) });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FormCategory>('OTHER');
  const [screens, setScreens] = useState<Screen[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [problems, setProblems] = useState<FormProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!form.data || loaded) return;
    setName(form.data.name);
    setCategory(form.data.category);
    setScreens(form.data.draft.screens?.length ? form.data.draft.screens : [{ title: 'Your details', button: 'Submit', fields: [] }]);
    setMapping(Object.fromEntries(form.data.mapping.map((m) => [m.fieldKey, m.attributeKey])));
    setTagIds(form.data.tagIds);
    setLoaded(true);
  }, [form.data, loaded]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['forms'] });
  const body = () => ({
    name: name.trim(),
    category,
    draft: { screens },
    mapping: Object.entries(mapping)
      .filter(([key, attribute]) => attribute && screens.some((s) => s.fields.some((f) => f.key === key)))
      .map(([fieldKey, attributeKey]) => ({ fieldKey, attributeKey })),
    tagIds,
  });
  const save = useMutation({
    mutationFn: () => api<FormDetail>(`/forms/${id}`, { method: 'PUT', json: body() }),
    onSuccess: () => {
      setError(null);
      toast.success('Draft saved');
      return refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const check = useMutation({
    mutationFn: async () => {
      await api(`/forms/${id}`, { method: 'PUT', json: body() });
      return api<{ problems: FormProblem[] }>(`/forms/${id}/check`, { method: 'POST' });
    },
    onSuccess: (res) => setProblems(res.problems),
    onError: (e) => setError(errorMessage(e)),
  });
  const publish = useMutation({
    mutationFn: async () => {
      await api(`/forms/${id}`, { method: 'PUT', json: body() });
      return api<FormVersion>(`/forms/${id}/publish`, { method: 'POST' });
    },
    onSuccess: (version) => {
      setError(null);
      setProblems([]);
      toast.success(`Published as version ${version.number}`);
      return refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.details)) setProblems(e.details.map((d) => ({ screen: null, fieldKey: d.field ?? null, message: d.issue ?? '' })));
      setError(errorMessage(e));
    },
  });
  const archive = useMutation({
    mutationFn: () => api<FormDetail>(`/forms/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Form archived');
      return refresh();
    },
    onError: toastError,
  });

  if (!form.data || !loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const archived = form.data.status === 'ARCHIVED';
  const setScreen = (i: number, patch: Partial<Screen>) => setScreens(screens.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setField = (i: number, k: number, patch: Partial<FormField>) => setScreen(i, { fields: screens[i]!.fields.map((f, j) => (j === k ? ({ ...f, ...patch } as FormField) : f)) });
  const allKeys = new Set(screens.flatMap((s) => s.fields.map((f) => f.key)));
  const nextKey = () => {
    for (let n = 1; ; n++) if (!allKeys.has(`field_${n}`)) return `field_${n}`;
  };

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/forms" className="text-sm text-muted-foreground hover:underline">
            ← Forms
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {form.data.name}
            <Badge variant={form.data.status === 'PUBLISHED' ? 'success' : 'outline'} data-testid="form-status">
              {form.data.status === 'PUBLISHED' ? `Published v${form.data.currentVersion}` : form.data.status === 'ARCHIVED' ? 'Archived' : 'Draft'}
            </Badge>
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/forms/${id}/answers`}>Answers ({form.data.answers})</Link>
          </Button>
          {!archived && form.data.status === 'PUBLISHED' ? (
            <ConfirmDialog
              title="Archive this form?"
              description="It can no longer be sent; its answers are kept."
              confirmLabel="Archive"
              onConfirm={() => archive.mutateAsync().then(() => undefined)}
              trigger={
                <Button variant="outline" size="sm">
                  Archive
                </Button>
              }
            />
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="form-name">Form name</Label>
            <Input id="form-name" maxLength={80} value={name} disabled={archived} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="form-kind">Kind</Label>
            <NativeSelect id="form-kind" value={category} disabled={archived} onChange={(e) => setCategory(e.target.value as FormCategory)}>
              {FORM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {FORM_CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      {screens.map((screen, i) => (
        <Card key={i} data-testid={`form-screen-${i + 1}`}>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Screen {i + 1}</CardTitle>
            {screens.length > 1 && !archived ? (
              <Button variant="ghost" size="sm" onClick={() => setScreens(screens.filter((_, j) => j !== i))}>
                Remove screen
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor={`screen-${i}-title`}>Screen {i + 1} title</Label>
                <Input id={`screen-${i}-title`} value={screen.title} disabled={archived} onChange={(e) => setScreen(i, { title: e.target.value })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`screen-${i}-button`}>Screen {i + 1} button</Label>
                <Input id={`screen-${i}-button`} value={screen.button} disabled={archived} onChange={(e) => setScreen(i, { button: e.target.value })} />
              </div>
            </div>
            {screen.fields.map((field, k) => (
              <div key={k} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_10rem]" data-testid={`form-field-${field.key}`}>
                <div className="grid gap-1">
                  <Label htmlFor={`field-${i}-${k}-label`}>Field {k + 1} label</Label>
                  <Input id={`field-${i}-${k}-label`} value={field.label} disabled={archived} onChange={(e) => setField(i, k, { label: e.target.value })} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`field-${i}-${k}-key`}>Field {k + 1} key</Label>
                  <Input id={`field-${i}-${k}-key`} value={field.key} disabled={archived} onChange={(e) => setField(i, k, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) })} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`field-${i}-${k}-type`}>Field {k + 1} type</Label>
                  <NativeSelect id={`field-${i}-${k}-type`} value={field.type} disabled={archived} onChange={(e) => setField(i, k, { type: e.target.value as FormFieldType, ...(FORM_CHOICE_TYPES.includes(e.target.value as FormFieldType) ? { options: field.options ?? [] } : {}) })}>
                    {FORM_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {FORM_FIELD_LABEL[t]}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {FORM_CHOICE_TYPES.includes(field.type) ? (
                  <div className="grid gap-1 sm:col-span-3">
                    <Label htmlFor={`field-${i}-${k}-options`}>Field {k + 1} options (one per line)</Label>
                    <textarea
                      id={`field-${i}-${k}-options`}
                      className="min-h-[72px] rounded-md border bg-background px-3 py-2 text-sm"
                      disabled={archived}
                      value={(field.options ?? []).map((o) => o.title).join('\n')}
                      onChange={(e) => setField(i, k, { options: e.target.value.split('\n').filter((l) => l.trim()).map((title) => ({ id: slug(title), title: title.trim() })) })}
                    />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-4 sm:col-span-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={field.required} disabled={archived} onChange={(e) => setField(i, k, { required: e.target.checked })} />
                    Required
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    Save to attribute
                    <NativeSelect aria-label={`Attribute for ${field.key}`} value={mapping[field.key] ?? ''} disabled={archived} onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value })}>
                      <option value="">Do not save</option>
                      {(attributes.data ?? []).map((a) => (
                        <option key={a.key} value={a.key}>
                          {a.label} ({a.key})
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  {!archived ? (
                    <Button variant="ghost" size="sm" onClick={() => setScreen(i, { fields: screen.fields.filter((_, j) => j !== k) })}>
                      Remove field
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {!archived ? (
              <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setScreen(i, { fields: [...screen.fields, { key: nextKey(), type: 'shortText', label: '', required: false } as FormField] })}>
                Add field
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ))}
      {!archived && screens.length < 10 ? (
        <Button variant="outline" className="justify-self-start" onClick={() => setScreens([...screens, { title: `Screen ${screens.length + 1}`, button: 'Submit', fields: [] }])}>
          Add screen
        </Button>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tags when answered</CardTitle>
          <CardDescription>Added to the contact with every answer.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {(tags.data ?? []).map((t) => (
            <label key={t.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={archived} checked={tagIds.includes(t.id)} onChange={(e) => setTagIds(e.target.checked ? [...tagIds, t.id] : tagIds.filter((x) => x !== t.id))} />
              {t.name}
            </label>
          ))}
        </CardContent>
      </Card>

      {problems !== null ? (
        problems.length ? (
          <ul className="grid gap-1 text-sm text-destructive" aria-label="Problems" data-testid="form-problems">
            {problems.map((p, i) => (
              <li key={i}>
                {p.screen !== null && p.screen !== undefined ? `Screen ${p.screen + 1}: ` : ''}
                {p.fieldKey ? `${p.fieldKey}: ` : ''}
                {p.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-success" data-testid="form-ready">
            Ready to publish.
          </p>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!archived ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
            Save draft
          </Button>
          <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
            Check
          </Button>
          <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      ) : null}

      {form.data.versions.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm" data-testid="form-versions">
              {form.data.versions.map((v) => (
                <li key={v.id}>
                  v{v.number} · {v.status.toLowerCase()} · {new Date(v.publishedAt).toLocaleString()} · {(v.accounts ?? []).length} account{(v.accounts ?? []).length === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
