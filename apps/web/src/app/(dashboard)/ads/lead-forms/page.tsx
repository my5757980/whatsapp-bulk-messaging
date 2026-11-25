'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { WelcomeMapping, type MappingSource } from '@/components/ads/welcome-mapping';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { adsKeys, type AdLeadForm } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Tag, Template } from '@/lib/types';

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([^a-z])/, 'q_$1')
    .slice(0, 40) || 'question';

/** Ads > Lead forms (feature 007 US7, FR-035 – FR-039): forms at Meta whose leads become WhatsApp contacts. */
export default function LeadFormsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <LeadForms />
    </RequirePermission>
  );
}

function LeadForms() {
  const forms = useQuery({ queryKey: adsKeys.leadForms, queryFn: () => api<AdLeadForm[]>('/ads/lead-forms') });
  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <Link href="/ads" className="text-sm text-muted-foreground hover:underline">
          ← Ads
        </Link>
        <h1 className="text-2xl font-semibold">Lead forms</h1>
        <p className="text-sm text-muted-foreground">
          Forms shown inside lead ads. Each lead becomes a contact with the form&apos;s tag; only people who tick the WhatsApp box are opted in and get the welcome message.
        </p>
      </div>
      <Can permission="campaigns.manage">
        <NewLeadForm />
      </Can>
      {forms.data?.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Form</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead>Last lead</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {forms.data.map((f) => (
              <TableRow key={f.id}>
                <TableCell>
                  <Link href={`/ads/lead-forms/${f.id}`} className="font-medium hover:underline">
                    {f.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right">{f.leads}</TableCell>
                <TableCell>{formatDateTime(f.lastLeadAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : forms.isSuccess ? (
        <p className="text-sm text-muted-foreground">No lead forms yet.</p>
      ) : null}
    </div>
  );
}

function NewLeadForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(false);
  const [custom, setCustom] = useState<string[]>([]);
  const [privacyUrl, setPrivacyUrl] = useState('');
  const [consentText, setConsentText] = useState('Yes, send me offers and updates on WhatsApp');
  const [tagId, setTagId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mapping, setMapping] = useState<Record<string, MappingSource>>({});
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const templates = useQuery({ queryKey: queryKeys.templates({ status: 'APPROVED' }), queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const template = (templates.data ?? []).find((t) => t.id === templateId);
  const answers = [
    { key: 'full_name', label: 'Full name' },
    ...(email ? [{ key: 'email', label: 'Email' }] : []),
    ...custom.filter((c) => c.trim()).map((c) => ({ key: slug(c), label: c.trim() })),
  ];

  const create = useMutation({
    mutationFn: () => {
      const welcomeMapping = Object.fromEntries((template?.variables ?? []).map((v) => [v.key, mapping[v.key] ?? { source: 'column', key: 'full_name', fallback: 'there' }]));
      return api<AdLeadForm>('/ads/lead-forms', {
        method: 'POST',
        json: {
          name: name.trim(),
          questions: { standard: ['FULL_NAME', 'PHONE', ...(email ? ['EMAIL'] : [])], ...(custom.some((c) => c.trim()) ? { custom: custom.filter((c) => c.trim()).map((c) => ({ key: slug(c), label: c.trim() })) } : {}) },
          privacyUrl: privacyUrl.trim(),
          consentText: consentText.trim(),
          tagId: tagId || null,
          welcomeTemplateId: templateId || null,
          ...(templateId ? { welcomeMapping } : {}),
        },
      });
    },
    onSuccess: async () => {
      toast.success('Lead form made at Meta');
      setName('');
      await queryClient.invalidateQueries({ queryKey: adsKeys.leadForms });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return toast.error('Name the form.');
    if (!privacyUrl.trim().startsWith('https://')) return toast.error('Give the https address of the privacy policy.');
    create.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New lead form</CardTitle>
        <CardDescription>Meta does not let a form change once it is in use; make a new one to change the questions.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="form-name">Form name</Label>
            <Input id="form-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <fieldset className="grid gap-1 text-sm">
            <legend className="font-medium">Questions</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4" checked disabled /> Full name
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4" checked disabled /> Phone number (needed for WhatsApp)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email
            </label>
            {custom.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`Own question ${i + 1}`} value={c} maxLength={80} onChange={(e) => setCustom((list) => list.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setCustom((list) => list.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            {custom.length < 3 ? (
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setCustom((list) => [...list, ''])}>
                Add own question
              </Button>
            ) : null}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="form-privacy">Privacy policy (https)</Label>
            <Input id="form-privacy" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="form-consent">WhatsApp consent checkbox</Label>
            <Input id="form-consent" value={consentText} maxLength={300} onChange={(e) => setConsentText(e.target.value)} />
            <p className="text-xs text-muted-foreground">Unticked by default; it must name WhatsApp.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="form-tag">Tag for leads</Label>
              <NativeSelect id="form-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                <option value="">No tag</option>
                {(tags.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="form-template">Welcome template (to people who tick the box)</Label>
              <NativeSelect id="form-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">No welcome message</option>
                {(templates.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          {template ? <WelcomeMapping variables={template.variables} answers={answers} value={mapping} onChange={setMapping} /> : null}
          <Button type="submit" className="justify-self-start" disabled={create.isPending}>
            {create.isPending ? 'Making…' : 'Make lead form'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
