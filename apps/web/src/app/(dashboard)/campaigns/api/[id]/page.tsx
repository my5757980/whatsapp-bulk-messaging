'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseVariableKey } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { ApiError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber, titleCase } from '@/lib/format';
import {
  API_CAMPAIGN_STATUS_LABEL,
  API_CAMPAIGN_STATUS_VARIANT,
  NOT_SENT_REASON_LABEL,
  PAUSED_REASON_LABEL,
  RESULT_LABELS,
  type ApiCampaign,
  type ApiCampaignResults,
  type VariableSource,
} from '@/lib/integrations';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, Template } from '@/lib/types';

type Problem = { code: string; message: string };

/** Campaigns > API campaigns > one campaign (feature 006 US3, T041): settings, state, the request and results. */
export default function ApiCampaignPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <ApiCampaignView />
    </RequirePermission>
  );
}

function problemsOf(error: unknown): Problem[] {
  return error instanceof ApiError && Array.isArray(error.extra?.problems) ? (error.extra.problems as Problem[]) : [];
}

function ApiCampaignView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const campaign = useQuery({ queryKey: ['api-campaign', id], queryFn: () => api<ApiCampaign>(`/api-campaigns/${id}`) });
  const results = useQuery({ queryKey: ['api-campaign-results', id], queryFn: () => api<ApiCampaignResults>(`/api-campaigns/${id}/results`) });
  const [problems, setProblems] = useState<Problem[]>([]);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['api-campaign', id] }), queryClient.invalidateQueries({ queryKey: ['api-campaigns'] })]);

  const action = useMutation({
    mutationFn: (step: 'go-live' | 'pause' | 'stop') => api<ApiCampaign>(`/api-campaigns/${id}/${step}`, { method: 'POST' }),
    onSuccess: (c) => {
      setProblems([]);
      toast.success(c.status === 'LIVE' ? 'The campaign is live' : c.status === 'PAUSED' ? 'The campaign is paused' : 'The campaign is stopped');
      return refresh();
    },
    onError: (e) => {
      setProblems(problemsOf(e));
      toast.error(errorMessage(e));
    },
  });

  if (campaign.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (campaign.error || !campaign.data) return <p className="text-sm text-destructive">{errorMessage(campaign.error)}</p>;
  const c = campaign.data;

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link href="/campaigns/api" className="text-sm text-muted-foreground hover:underline">
            ← API campaigns
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{c.name}</h2>
            <Badge data-testid="api-campaign-status" variant={API_CAMPAIGN_STATUS_VARIANT[c.status]}>
              {API_CAMPAIGN_STATUS_LABEL[c.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{c.apiName}</span> · {c.templateName} · {c.templateLanguage} · from {c.numberLabel}
          </p>
          {c.status === 'PAUSED' && c.pausedReason ? <p className="text-sm font-medium">{PAUSED_REASON_LABEL[c.pausedReason]}</p> : null}
        </div>
        <Can permission="campaigns.launch">
          <div className="flex flex-wrap gap-2">
            {c.status === 'DRAFT' || c.status === 'PAUSED' ? (
              <Button onClick={() => action.mutate('go-live')} disabled={action.isPending}>
                Set live
              </Button>
            ) : null}
            {c.status === 'LIVE' ? (
              <Button variant="outline" onClick={() => action.mutate('pause')} disabled={action.isPending}>
                Pause
              </Button>
            ) : null}
            {c.status !== 'STOPPED' ? (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" className="text-destructive">
                    Stop
                  </Button>
                }
                title={`Stop "${c.name}"?`}
                description="Calls are refused from now on. Results stay, and the name can be used again. A stopped campaign cannot go live again."
                confirmLabel="Stop campaign"
                confirmVariant="destructive"
                onConfirm={() => action.mutateAsync('stop').then(() => undefined, () => undefined)}
              />
            ) : null}
          </div>
        </Can>
      </div>

      {problems.length ? (
        <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
          <p className="font-medium">Fix these first:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={`${p.code}-${p.message}`}>{p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {c.status !== 'STOPPED' ? (
        <Can permission="campaigns.manage">
          <Editor key={c.updatedAt} campaign={c} onSaved={refresh} onProblems={setProblems} />
        </Can>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ready-made request</CardTitle>
          <CardDescription>
            Use an API key with the permission &quot;Trigger API campaigns&quot; (Settings → API keys). Send a new Idempotency-Key for each message, so a retry never sends twice.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <pre data-testid="call-example" className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
            {c.callExample}
          </pre>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(c.callExample)
                  .then(() => toast.success('Request copied'))
                  .catch(() => toast.error('Copy failed; select the text and copy it'))
              }
            >
              Copy
            </Button>
          </div>
        </CardContent>
      </Card>

      <ResultsCard id={id} results={results.data} error={results.error} todayTriggers={c.todayTriggers} dailyLimit={c.dailyLimit} />
    </div>
  );
}

interface AttributeRow {
  key: string;
  mode: 'fixed' | 'value';
  value: string;
}

function attributeRows(attributes: Record<string, unknown>): AttributeRow[] {
  return Object.entries(attributes).map(([key, spec]) =>
    spec && typeof spec === 'object' && 'fromValue' in spec ? { key, mode: 'value' as const, value: String((spec as { fromValue: unknown }).fromValue) } : { key, mode: 'fixed' as const, value: String(spec) },
  );
}

const MEDIA_KIND = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' } as const;

/** Template, mapping, header file, tags, attributes, the new-contact rule and the daily limit. */
function Editor({ campaign, onSaved, onProblems }: { campaign: ApiCampaign; onSaved: () => Promise<unknown>; onProblems: (p: Problem[]) => void }) {
  const [name, setName] = useState(campaign.name);
  const [apiName, setApiName] = useState(campaign.apiName);
  const [templateId, setTemplateId] = useState(campaign.templateId);
  const [mapping, setMapping] = useState<Record<string, VariableSource | undefined>>(campaign.variableMapping);
  const [headerMediaAssetId, setHeaderMediaAssetId] = useState(campaign.headerMediaAssetId ?? '');
  const [tags, setTags] = useState(campaign.tags.join(', '));
  const [attributes, setAttributes] = useState<AttributeRow[]>(attributeRows(campaign.attributes));
  const [createContacts, setCreateContacts] = useState(campaign.createContacts);
  const [dailyLimit, setDailyLimit] = useState(campaign.dailyLimit ? String(campaign.dailyLimit) : '');
  const [error, setError] = useState<string | null>(null);

  const templates = useQuery({ queryKey: queryKeys.templates({ status: 'APPROVED' }), queryFn: () => api<Template[]>('/templates?status=APPROVED') });
  const definitions = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  // Templates of the same WhatsApp account as the current one (the number stays the same).
  const currentWaba = (templates.data ?? []).find((t) => t.id === campaign.templateId)?.wabaId;
  const sameAccount = currentWaba ? (templates.data ?? []).filter((t) => t.wabaId === currentWaba) : [];
  const chosen = (templates.data ?? []).find((t) => t.id === templateId);
  const variables = templateId === campaign.templateId ? campaign.variables : (chosen?.variables ?? []).map((v) => v.key);
  const chosenHeader = chosen?.components.find((x) => x.type.toUpperCase() === 'HEADER')?.format?.toUpperCase();
  const mediaType: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null =
    templateId === campaign.templateId
      ? campaign.headerMediaType
      : chosenHeader === 'IMAGE' || chosenHeader === 'VIDEO' || chosenHeader === 'DOCUMENT'
        ? chosenHeader
        : null;
  const media = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'), enabled: Boolean(mediaType) });
  const mediaChoices = mediaType ? (media.data?.items ?? []).filter((m) => m.kind === MEDIA_KIND[mediaType]) : [];
  const fieldOptions = [
    { value: 'name', label: 'Name' },
    { value: 'phone', label: 'Phone' },
    ...(definitions.data ?? []).map((d) => ({ value: `attributes.${d.key}`, label: d.label })),
  ];

  const save = useMutation({
    mutationFn: () => {
      const variableMapping = Object.fromEntries(variables.flatMap((v) => (mapping[v] ? [[v, mapping[v]]] : [])));
      const body = {
        name: name.trim(),
        ...(apiName.trim() !== campaign.apiName ? { apiName: apiName.trim() } : {}),
        ...(templateId !== campaign.templateId ? { templateId } : {}),
        variableMapping,
        headerMediaAssetId: mediaChoices.length && headerMediaAssetId ? headerMediaAssetId : null,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        attributes: Object.fromEntries(attributes.filter((a) => a.key && a.value.trim()).map((a) => [a.key, a.mode === 'value' ? { fromValue: a.value.trim() } : a.value.trim()])),
        createContacts,
        dailyLimit: dailyLimit.trim() ? Number(dailyLimit) : null,
      };
      return api<ApiCampaign>(`/api-campaigns/${campaign.id}`, { method: 'PATCH', json: body });
    },
    onSuccess: () => {
      setError(null);
      onProblems([]);
      toast.success('Changes saved');
      return onSaved();
    },
    onError: (e) => {
      onProblems(problemsOf(e));
      setError(errorMessage(e));
    },
  });

  const setSource = (variable: string, source: VariableSource | undefined) => setMapping((m) => ({ ...m, [variable]: source }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
        <CardDescription>
          {campaign.status === 'LIVE' ? 'Changes apply to new calls only.' : 'Map every template value, then set the campaign live.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ac-edit-name">Campaign name</Label>
              <Input id="ac-edit-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-edit-api-name">API name</Label>
              <Input id="ac-edit-api-name" value={apiName} maxLength={60} className="font-mono text-sm" disabled={Boolean(campaign.wentLiveAt)} onChange={(e) => setApiName(e.target.value)} />
              {campaign.wentLiveAt ? <p className="text-xs text-muted-foreground">Fixed since the campaign went live: callers use it.</p> : null}
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="ac-edit-template">Approved template</Label>
              <NativeSelect id="ac-edit-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {sameAccount.some((t) => t.id === campaign.templateId) ? null : (
                  <option value={campaign.templateId}>
                    {campaign.templateName} · {campaign.templateLanguage} (not approved)
                  </option>
                )}
                {sameAccount.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language} · {titleCase(t.category)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">Template values</legend>
            {variables.length ? null : <p className="text-sm text-muted-foreground">This template has no values to fill.</p>}
            {variables.map((variable) => (
              <MappingRow key={variable} variable={variable} source={mapping[variable]} fieldOptions={fieldOptions} onChange={(s) => setSource(variable, s)} />
            ))}
          </fieldset>

          {mediaType ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ac-edit-media">Header {mediaType.toLowerCase()}</Label>
              <NativeSelect id="ac-edit-media" value={headerMediaAssetId} onChange={(e) => setHeaderMediaAssetId(e.target.value)}>
                <option value="">Sent with each call (mediaUrl)</option>
                {mediaChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="ac-edit-tags">Tags to add</Label>
            <Input id="ac-edit-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="feedback, shop" />
            <p className="text-xs text-muted-foreground">Comma-separated; added to the contact on every message.</p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Attributes to set</legend>
            {attributes.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_12rem_1fr_auto] sm:items-end">
                <div className="grid gap-1">
                  <Label htmlFor={`ac-attr-key-${index}`}>Attribute</Label>
                  <NativeSelect
                    id={`ac-attr-key-${index}`}
                    value={row.key}
                    onChange={(e) => setAttributes((rows) => rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
                  >
                    <option value="">Choose…</option>
                    {(definitions.data ?? []).map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`ac-attr-mode-${index}`}>Value from</Label>
                  <NativeSelect
                    id={`ac-attr-mode-${index}`}
                    value={row.mode}
                    onChange={(e) => setAttributes((rows) => rows.map((r, i) => (i === index ? { ...r, mode: e.target.value as AttributeRow['mode'] } : r)))}
                  >
                    <option value="fixed">Fixed value</option>
                    <option value="value">A value of the call</option>
                  </NativeSelect>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`ac-attr-value-${index}`}>{row.mode === 'value' ? 'Value name' : 'Value'}</Label>
                  <Input
                    id={`ac-attr-value-${index}`}
                    value={row.value}
                    onChange={(e) => setAttributes((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))}
                  />
                </div>
                <Button type="button" variant="ghost" onClick={() => setAttributes((rows) => rows.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              </div>
            ))}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setAttributes((rows) => [...rows, { key: '', mode: 'fixed', value: '' }])}>
                Add attribute
              </Button>
            </div>
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={createContacts} onChange={(e) => setCreateContacts(e.target.checked)} />
            <span className="grid gap-0.5">
              <span>New phone numbers become contacts</span>
              <span className="text-xs text-muted-foreground">Off: calls for numbers that are not contacts yet are refused.</span>
            </span>
          </label>

          <div className="grid max-w-xs gap-1.5">
            <Label htmlFor="ac-edit-limit">Daily limit (messages a day)</Label>
            <Input id="ac-edit-limit" type="number" min={1} max={100000} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder="No limit" />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MappingRow({
  variable,
  source,
  fieldOptions,
  onChange,
}: {
  variable: string;
  source: VariableSource | undefined;
  fieldOptions: Array<{ value: string; label: string }>;
  onChange: (source: VariableSource | undefined) => void;
}) {
  const id = variable.replace(/[^A-Za-z0-9]/g, '-');
  const ref = parseVariableKey(variable);
  return (
    <div data-testid={`mapping-${variable}`} className="grid gap-2 sm:grid-cols-[9rem_13rem_1fr] sm:items-end">
      <div className="text-sm">
        <span className="font-mono">{`{{${ref?.placeholder ?? variable}}}`}</span>
        <span className="ml-1 text-xs text-muted-foreground">{ref ? titleCase(ref.component) : ''}</span>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`ac-src-${id}`}>Source</Label>
        <NativeSelect
          id={`ac-src-${id}`}
          value={source?.source ?? ''}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next === 'value' ? { source: 'value', key: '' } : next === 'field' ? { source: 'field', key: 'name' } : next === 'static' ? { source: 'static', value: '' } : undefined);
          }}
        >
          <option value="">Choose…</option>
          <option value="value">Value from the call</option>
          <option value="field">Contact field</option>
          <option value="static">Fixed text</option>
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        {source?.source === 'value' ? (
          <>
            <Label htmlFor={`ac-val-${id}`}>Value name</Label>
            <Input id={`ac-val-${id}`} value={source.key} className="font-mono text-sm" placeholder="order" onChange={(e) => onChange({ source: 'value', key: e.target.value.trim() })} />
          </>
        ) : source?.source === 'field' ? (
          <>
            <Label htmlFor={`ac-fld-${id}`}>Contact field</Label>
            <NativeSelect id={`ac-fld-${id}`} value={source.key} onChange={(e) => onChange({ source: 'field', key: e.target.value })}>
              {fieldOptions.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </NativeSelect>
          </>
        ) : source?.source === 'static' ? (
          <>
            <Label htmlFor={`ac-txt-${id}`}>Fixed text</Label>
            <Input id={`ac-txt-${id}`} value={source.value} maxLength={1024} onChange={(e) => onChange({ source: 'static', value: e.target.value })} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function ResultsCard({
  id,
  results,
  error,
  todayTriggers,
  dailyLimit,
}: {
  id: string;
  results: ApiCampaignResults | undefined;
  error: unknown;
  todayTriggers: number;
  dailyLimit: number | null;
}) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">Results</CardTitle>
          <CardDescription>
            {results ? `${results.from} to ${results.to}` : 'Last 30 days'} · {formatNumber(todayTriggers)} triggers today
            {dailyLimit ? ` (limit ${formatNumber(dailyLimit)} messages)` : ''}
          </CardDescription>
        </div>
        <Can permission="data.export">
          <a href={`/api/api-campaigns/${id}/export`} className="text-sm font-medium underline-offset-4 hover:underline">
            Export CSV
          </a>
        </Can>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
        {results ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {RESULT_LABELS.map(([key, label]) => (
                <div key={key} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div data-testid={`result-${key}`} className="text-xl font-semibold tabular-nums">
                    {formatNumber(results.totals[key])}
                  </div>
                </div>
              ))}
            </div>
            {results.days.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Day</TableHead>
                    {RESULT_LABELS.map(([key, label]) => (
                      <TableHead key={key} className="text-right">
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.days.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>{day.date}</TableCell>
                      {RESULT_LABELS.map(([key]) => (
                        <TableCell key={key} className="text-right tabular-nums">
                          {formatNumber(day[key])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No triggers yet.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <ReasonList title="Not sent, by reason" reasons={results.notSentReasons} labels={NOT_SENT_REASON_LABEL} />
              <ReasonList title="Failed, by reason" reasons={results.failureReasons ?? {}} labels={{}} />
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReasonList({ title, reasons, labels }: { title: string; reasons: Record<string, number>; labels: Record<string, string> }) {
  const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-1">
      <div className="text-sm font-medium">{title}</div>
      {entries.length ? (
        <ul className="grid gap-0.5 text-sm">
          {entries.map(([reason, count]) => (
            <li key={reason} className="flex justify-between gap-3">
              <span>{labels[reason] ?? reason}</span>
              <span className="tabular-nums">{formatNumber(count)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None.</p>
      )}
    </div>
  );
}
