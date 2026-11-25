'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { suggestApiName } from '@wbm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber, titleCase } from '@/lib/format';
import { API_CAMPAIGN_STATUS_LABEL, API_CAMPAIGN_STATUS_VARIANT, type ApiCampaign, type ApiCampaignStatus } from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Template, WhatsAppNumber } from '@/lib/types';

const STATUSES: Array<'' | ApiCampaignStatus> = ['', 'DRAFT', 'LIVE', 'PAUSED', 'STOPPED'];

/** Campaigns > API campaigns (feature 006 US3, T041): templates other systems send with one call. */
export default function ApiCampaignsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <ApiCampaignList />
    </RequirePermission>
  );
}

function ApiCampaignList() {
  const [status, setStatus] = useState<'' | ApiCampaignStatus>('');
  const campaigns = useQuery({
    queryKey: ['api-campaigns', status],
    queryFn: () => api<ApiCampaign[]>(`/api-campaigns${status ? `?status=${status}` : ''}`),
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/campaigns" className="text-sm text-muted-foreground hover:underline">
            ← Campaigns
          </Link>
          <h2 className="text-lg font-semibold">API campaigns</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A saved template, mapping and set of rules that your shop, CRM or booking system sends with one call: a phone number and a few values.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | ApiCampaignStatus)}>
            {STATUSES.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? API_CAMPAIGN_STATUS_LABEL[s] : 'All states'}
              </option>
            ))}
          </NativeSelect>
          <Can permission="campaigns.manage">
            <NewApiCampaignDialog />
          </Can>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {campaigns.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : campaigns.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(campaigns.error)}</p>
          ) : !campaigns.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No API campaigns yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>API name</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Triggers today</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.data.map((c) => (
                  <TableRow key={c.id} data-testid="api-campaign-row">
                    <TableCell>
                      <Link href={`/campaigns/api/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{c.apiName}</TableCell>
                    <TableCell className="text-sm">
                      {c.templateName} · {c.templateLanguage}
                    </TableCell>
                    <TableCell>
                      <Badge variant={API_CAMPAIGN_STATUS_VARIANT[c.status]}>{API_CAMPAIGN_STATUS_LABEL[c.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(c.todayTriggers)}
                      {c.dailyLimit ? <span className="text-muted-foreground"> / {formatNumber(c.dailyLimit)}</span> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Name, API name, number and template; the rest is set on the campaign's page. */
function NewApiCampaignDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [apiName, setApiName] = useState('');
  const [apiNameEdited, setApiNameEdited] = useState(false);
  const [numberId, setNumberId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers'), enabled: open });
  const templates = useQuery({ queryKey: queryKeys.templates({ status: 'APPROVED' }), queryFn: () => api<Template[]>('/templates?status=APPROVED'), enabled: open });
  const connected = (numbers.data ?? []).filter((n) => n.connectionStatus === 'CONNECTED');
  const selected = connected.find((n) => n.id === numberId);
  const usable = (templates.data ?? []).filter((t) => selected && t.wabaId === selected.wabaId);

  const create = useMutation({
    mutationFn: () => api<ApiCampaign>('/api-campaigns', { method: 'POST', json: { name: name.trim(), apiName: apiName.trim(), numberId, templateId } }),
    onSuccess: (c) => router.push(`/campaigns/api/${c.id}`),
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !apiName.trim() || !numberId || !templateId) {
      setError('Enter a name and an API name, and choose a number and a template.');
      return;
    }
    create.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setApiName('');
          setApiNameEdited(false);
          setNumberId('');
          setTemplateId('');
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>New API campaign</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New API campaign</DialogTitle>
          <DialogDescription>It starts as a draft. Map the template&apos;s values and set it live on the next page.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ac-name">Campaign name</Label>
            <Input
              id="ac-name"
              value={name}
              maxLength={120}
              placeholder="Order feedback"
              onChange={(e) => {
                setName(e.target.value);
                if (!apiNameEdited) setApiName(e.target.value.trim() ? suggestApiName(e.target.value) : '');
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ac-api-name">API name</Label>
            <Input
              id="ac-api-name"
              value={apiName}
              maxLength={60}
              className="font-mono text-sm"
              onChange={(e) => {
                setApiName(e.target.value);
                setApiNameEdited(true);
              }}
            />
            <p className="text-xs text-muted-foreground">Callers use it in the address. Lower-case letters, digits and dashes; it cannot change after the campaign goes live.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ac-number">Send from</Label>
            <NativeSelect
              id="ac-number"
              value={numberId}
              onChange={(e) => {
                setNumberId(e.target.value);
                setTemplateId('');
              }}
            >
              <option value="">Choose a connected number…</option>
              {connected.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} ({n.displayPhoneNumber})
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ac-template">Approved template</Label>
            <NativeSelect id="ac-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!numberId}>
              <option value="">Choose a template…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.language} · {titleCase(t.category)}
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
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create draft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
