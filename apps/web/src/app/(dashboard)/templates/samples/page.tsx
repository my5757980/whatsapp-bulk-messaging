'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { SAMPLE_INDUSTRIES, SAMPLE_PURPOSES, SAMPLE_TYPES, type TemplateSample } from '@wbm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { TemplatePreview } from '@/components/templates/template-preview';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { titleCase } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';

// Feature 009 (US6, FR-024 - FR-026): the sample library. A sample is copied into a draft for an
// account and opened in the editor, which asks for any media file before it is submitted.

const TYPE_WORDS: Record<(typeof SAMPLE_TYPES)[number], string> = { TEXT: 'Text', MEDIA: 'Media', CAROUSEL: 'Carousel', OFFER: 'Limited-time offer', AUTHENTICATION: 'One-time code' };

function UseSampleDialog({ sample, onClose }: { sample: TemplateSample; onClose: () => void }) {
  const router = useRouter();
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of numbers.data ?? []) if (n.connectionStatus === 'CONNECTED' && !seen.has(n.wabaId)) seen.set(n.wabaId, `${n.verifiedName} (${n.wabaId})`);
    return [...seen.entries()];
  }, [numbers.data]);
  const [wabaId, setWabaId] = useState('');
  const [name, setName] = useState(sample.name);
  const [error, setError] = useState<string | null>(null);
  const account = wabaId || accounts[0]?.[0] || '';
  const copy = useMutation({
    mutationFn: () => api<{ id: string }>(`/template-samples/${sample.id}/copy`, { method: 'POST', json: { wabaId: account, name } }),
    onSuccess: (draft) => router.push(`/templates/new?from=${draft.id}&draft=1`),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use this sample</DialogTitle>
          <DialogDescription>A draft is made with the sample&apos;s text and examples. Change anything you like in the editor, then submit it to Meta.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sample-account">Account</Label>
            <NativeSelect id="sample-account" value={account} onChange={(e) => setWabaId(e.target.value)}>
              {accounts.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sample-name">Template name</Label>
            <Input id="sample-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => copy.mutate()} disabled={copy.isPending || !account || !name}>
            {copy.isPending ? 'Making the draft…' : 'Make the draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SamplesView() {
  const [industry, setIndustry] = useState('');
  const [purpose, setPurpose] = useState('');
  const [type, setType] = useState('');
  const [language, setLanguage] = useState('');
  const [search, setSearch] = useState('');
  const [using, setUsing] = useState<TemplateSample | null>(null);
  const query = new URLSearchParams(Object.entries({ industry, purpose, type, language, search: search.trim() }).filter(([, v]) => v)).toString();
  const samples = useQuery({ queryKey: ['template-samples', query], queryFn: () => api<{ items: TemplateSample[] }>(`/template-samples${query ? `?${query}` : ''}`) });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Sample templates</h1>
          <p className="text-sm text-muted-foreground">Ready-made texts for common messages. Copy one into a draft and make it yours.</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/templates">Back to templates</Link>
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        <div className="grid gap-1.5">
          <Label htmlFor="sample-industry">Industry</Label>
          <NativeSelect id="sample-industry" value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">All industries</option>
            {SAMPLE_INDUSTRIES.map((i) => (
              <option key={i} value={i}>
                {titleCase(i)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sample-purpose">Purpose</Label>
          <NativeSelect id="sample-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">All purposes</option>
            {SAMPLE_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sample-type">Type</Label>
          <NativeSelect id="sample-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {SAMPLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_WORDS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sample-language">Language</Label>
          <NativeSelect id="sample-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="ar">Arabic</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sample-search">Search</Label>
          <Input id="sample-search" value={search} maxLength={100} placeholder="invoice, booking…" onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {samples.isLoading ? <p className="text-sm text-muted-foreground">Loading samples…</p> : null}
      {samples.error ? <p className="text-sm text-destructive">{errorMessage(samples.error)}</p> : null}
      {samples.data && !samples.data.items.length ? <p className="text-sm text-muted-foreground">No sample matches these filters.</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(samples.data?.items ?? []).map((s) => (
          <Card key={s.id} data-testid={`sample-${s.id}`}>
            <CardHeader className="gap-2">
              <CardTitle className="font-mono text-base">{s.name}</CardTitle>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">{titleCase(s.industry)}</Badge>
                <Badge variant="secondary">{titleCase(s.purpose)}</Badge>
                <Badge variant="outline">{TYPE_WORDS[s.type]}</Badge>
                <Badge variant="outline">{titleCase(s.category)}</Badge>
                <Badge variant="outline">{s.language === 'ar' ? 'Arabic' : 'English'}</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <TemplatePreview draft={s.draft} />
              <Can permission="templates.manage">
                <Button className="justify-self-start" onClick={() => setUsing(s)}>
                  Use this sample
                </Button>
              </Can>
            </CardContent>
          </Card>
        ))}
      </div>
      {using ? <UseSampleDialog sample={using} onClose={() => setUsing(null)} /> : null}
    </div>
  );
}

export default function TemplateSamplesPage() {
  return (
    <RequirePermission permission="templates.view">
      <SamplesView />
    </RequirePermission>
  );
}
