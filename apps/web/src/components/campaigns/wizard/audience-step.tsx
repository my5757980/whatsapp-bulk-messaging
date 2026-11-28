'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState, type FormEvent } from 'react';
import { AudienceRuleBuilder, isCompleteRule } from '@/components/campaigns/audience-rule-builder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, AudienceCounts, AudienceRule, Campaign, CampaignDetail, ImportJob, Tag, Template } from '@/lib/types';
import { cn } from '@/lib/utils';
import { contacts010Keys, type Segment, type SegmentCount } from '@/lib/contacts-010';
import Link from 'next/link';

/** Reads the header row in the browser so the user can pick the phone and name columns. */
async function readColumns(file: File): Promise<string[]> {
  const raw = await file.slice(0, 64 * 1024).text();
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 BOM
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (header.split(d).length > header.split(best).length ? d : best), ',');
  return header.split(delimiter).map((c, i) => c.trim().replace(/^"(.*)"$/, '$1') || `column_${i + 1}`);
}

function UploadSummary({ job, everyRow }: { job: ImportJob; everyRow: boolean }) {
  if (job.status === 'QUEUED' || job.status === 'PROCESSING') {
    return <p className="text-sm text-muted-foreground">Processing the list…</p>;
  }
  if (job.status === 'FAILED') return <p className="text-sm text-destructive">The upload failed: {job.error}</p>;
  const valid = job.createdCount + job.updatedCount;
  return (
    <div className="grid gap-1 rounded-md border bg-muted/40 p-4 text-sm" data-testid="upload-summary">
      <div className="font-medium">{formatNumber(job.totalRows)} rows processed</div>
      <div>
        {formatNumber(valid)} recipients ready ({formatNumber(job.createdCount)} new contacts, {formatNumber(job.updatedCount)} existing)
      </div>
      <div className="text-muted-foreground">
        {formatNumber(job.skippedCount)} skipped ({everyRow ? 'repeated rows are kept; opted out' : 'duplicates or opted out'}) · {formatNumber(job.errorCount)} invalid numbers
      </div>
    </div>
  );
}

/** Upload audience (T109): CSV upload with mandatory opt-in confirmation and source note. */
function UploadAudience({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [phoneColumn, setPhoneColumn] = useState('');
  const [nameColumn, setNameColumn] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(campaign.audienceUpload?.id ?? null);
  // Feature 009 (research R10): one message per row, even when a number repeats.
  const [everyRow, setEveryRow] = useState(Boolean(campaign.allowDuplicateRows));
  const saveEveryRow = useMutation({
    mutationFn: (on: boolean) => api<Campaign>(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { allowDuplicateRows: on } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) }),
    onError: (e) => setError(errorMessage(e)),
  });

  const job = useQuery({
    queryKey: ['import', jobId],
    queryFn: () => api<ImportJob>(`/imports/${jobId}`),
    enabled: Boolean(jobId),
    initialData: campaign.audienceUpload?.id === jobId ? (campaign.audienceUpload ?? undefined) : undefined,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'QUEUED' || q.state.data.status === 'PROCESSING') ? 1000 : false),
  });
  const finished = job.data?.status === 'COMPLETED';
  const finishedJobId = finished ? job.data?.id : undefined;
  useEffect(() => {
    // Refresh the draft so the next step sees the new upload's columns.
    if (finishedJobId && finishedJobId !== campaign.audienceUpload?.id) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) });
    }
  }, [finishedJobId, campaign.audienceUpload?.id, campaign.id, queryClient]);

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('file', file as File);
      form.set('phoneColumn', phoneColumn);
      if (nameColumn) form.set('nameColumn', nameColumn);
      form.set('optInConfirmed', String(confirmed));
      form.set('optInSourceNote', note.trim());
      return api<ImportJob>(`/campaigns/${campaign.id}/audience-upload`, { method: 'POST', body: form });
    },
    onSuccess: (created) => setJobId(created.id),
    onError: (e) => setError(errorMessage(e)),
  });

  async function chooseFile(next: File | null) {
    setFile(next);
    setError(null);
    if (!next) return;
    const cols = await readColumns(next);
    setColumns(cols);
    setPhoneColumn(cols.find((c) => /phone|mobile|whatsapp|number/i.test(c)) ?? '');
    setNameColumn(cols.find((c) => /name/i.test(c)) ?? '');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) return setError('Choose a CSV file.');
    if (!phoneColumn) return setError('Choose the column that holds phone numbers.');
    if (!confirmed) return setError('Confirm that every contact in the file opted in to receive these messages.');
    if (note.trim().length < 3) return setError('Describe where and how the contacts opted in.');
    upload.mutate();
  }

  return (
    <div className="grid max-w-2xl gap-6">
      <form onSubmit={submit} className="grid gap-5">
        <div className="grid gap-1.5">
          <Label htmlFor="audience-file">Recipient list (CSV, up to 50 MB)</Label>
          <Input id="audience-file" type="file" accept=".csv,text/csv" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} />
          <p className="text-xs text-muted-foreground">The first row must contain column names. Extra columns can fill template variables.</p>
        </div>
        {columns.length ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="phone-column">Phone number column</Label>
              <NativeSelect id="phone-column" value={phoneColumn} onChange={(e) => setPhoneColumn(e.target.value)}>
                <option value="">Choose…</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="name-column">Name column (optional)</Label>
              <NativeSelect id="name-column" value={nameColumn} onChange={(e) => setNameColumn(e.target.value)}>
                <option value="">None</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-sm" data-testid="every-row">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={everyRow}
            disabled={saveEveryRow.isPending}
            onChange={(e) => {
              setEveryRow(e.target.checked);
              saveEveryRow.mutate(e.target.checked);
            }}
          />
          <span>
            Send to every row: a number on several rows gets one message per row, each with that row&apos;s values.
            {jobId ? ' Upload the list again after changing this.' : ''}
          </span>
        </label>
        <div className="grid gap-3 rounded-md border p-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I confirm every contact in this file agreed to receive WhatsApp messages from us. Contacts who opted out will stay excluded.</span>
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="opt-in-note">Where did they opt in?</Label>
            <textarea
              id="opt-in-note"
              className="min-h-16 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Checkout consent box on our website, Oct 2026"
            />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={upload.isPending}>
            {upload.isPending ? 'Uploading…' : jobId ? 'Upload a new list' : 'Upload list'}
          </Button>
        </div>
      </form>
      {job.data ? <UploadSummary job={job.data} everyRow={everyRow} /> : null}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onDone} disabled={!finished || !(job.data && job.data.createdCount + job.data.updatedCount + job.data.skippedCount > 0)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

type AudienceMode = CampaignDetail['audienceType'];

/** Who a retarget draft goes to, in plain words (001 groups and the feature 005 groups). */
const RETARGET_LABEL: Record<string, string> = {
  FAILED: 'whose message failed',
  NOT_READ: 'who did not read it',
  READ: 'who read it',
  DELIVERED: 'who received it',
  CLICKED: 'who opened a link in it',
  NOT_CLICKED: 'who received it but did not open a link',
  REPLIED: 'who wrote back within 3 days of receiving it',
  NOT_REPLIED: 'who received it but did not write back within 3 days',
  HELD_BACK: "whose message Meta held back (per-person marketing limit)",
  PAID: 'who paid the payment request it sent',
  NOT_PAID: 'who received the payment request but did not pay',
};

/** Retarget audience (US5): recipients of the source campaign with the chosen result. */
function RetargetAudience({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  return (
    <div className="grid max-w-3xl gap-5">
      <div className="rounded-md border bg-muted/40 p-4 text-sm" data-testid="retarget-audience">
        Recipients of the original campaign {RETARGET_LABEL[campaign.retargetStatus ?? ''] ?? 'in the chosen group'}. They are selected when this
        campaign starts; contacts who opted out are left out automatically.
        {campaign.retargetStatus === 'HELD_BACK' ? (
          <p className="mt-2 text-amber-700">Meta asks to wait at least 24 hours before sending these people another marketing message. Schedule this campaign for tomorrow.</p>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onDone}>Continue</Button>
      </div>
    </div>
  );
}

const MODES: Array<{ value: AudienceMode; label: string; hint: string }> = [
  { value: 'UPLOAD', label: 'Upload a list', hint: 'A CSV file of people who opted in' },
  { value: 'FILTER', label: 'Filter contacts', hint: 'Tags and attributes from your contacts' },
  { value: 'ALL_OPTED_IN', label: 'All opted-in contacts', hint: 'Everyone who opted in' },
  // Feature 010 (FR-004): a saved segment, read at launch.
  { value: 'SEGMENT', label: 'Saved segment', hint: 'A segment from Contacts' },
];

function CountsBox({ counts, loading }: { counts: AudienceCounts | undefined; loading: boolean }) {
  if (!counts) return <p className="text-sm text-muted-foreground">{loading ? 'Counting…' : 'Complete the rules to see how many contacts match.'}</p>;
  return (
    <div className="rounded-md border bg-muted/40 p-4 text-sm" data-testid="audience-count">
      <div className="text-2xl font-semibold">{formatNumber(counts.eligible)}</div>
      <div>contacts will receive the message</div>
      <div className="text-xs text-muted-foreground">
        Excluded: {formatNumber(counts.excluded.optedOut)} opted out · {formatNumber(counts.excluded.noOptIn)} without opt-in (marketing)
      </div>
    </div>
  );
}

/** Filter audience (T131): tag and attribute rules with a live eligible count. */
function FilterAudience({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const template = useQuery({
    queryKey: ['template', campaign.templateId],
    queryFn: () => api<Template>(`/templates/${campaign.templateId}`),
    enabled: Boolean(campaign.templateId),
  });
  const [rules, setRules] = useState<AudienceRule[]>(campaign.audienceFilter?.all ?? [{ tag: '' }]);
  const [error, setError] = useState<string | null>(null);
  const deferred = useDeferredValue(rules);
  const ready = deferred.length > 0 && deferred.every(isCompleteRule);
  const body = { filter: { all: deferred }, templateCategory: template.data?.category ?? 'UTILITY' };
  const counts = useQuery({
    queryKey: queryKeys.audiencePreview(body),
    queryFn: () => api<AudienceCounts>('/contacts/audience-preview', { method: 'POST', json: body }),
    enabled: ready && template.isSuccess,
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: () => api<Campaign>(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { audienceType: 'FILTER', audienceFilter: { all: rules } } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) });
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const complete = rules.length > 0 && rules.every(isCompleteRule);

  return (
    <div className="grid max-w-3xl gap-5">
      <AudienceRuleBuilder rules={rules} onChange={setRules} tags={tags.data ?? []} attributes={attributes.data ?? []} />
      <CountsBox counts={ready ? counts.data : undefined} loading={counts.isFetching} />
      {counts.error ? <p className="text-sm text-destructive">{errorMessage(counts.error)}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={() => save.mutate()} disabled={!complete || save.isPending}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}

/** All opted-in audience (T131): every contact with an explicit opt-in. */
function AllOptedInAudience({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const counts = useQuery({
    queryKey: queryKeys.audiencePreview('all-opted-in'),
    queryFn: () => api<AudienceCounts>('/contacts/audience-preview', { method: 'POST', json: { filter: { all: [] }, templateCategory: 'MARKETING' } }),
  });
  return (
    <div className="grid max-w-3xl gap-5">
      <CountsBox counts={counts.data ? { ...counts.data, excluded: { ...counts.data.excluded, noOptIn: 0 } } : undefined} loading={counts.isLoading} />
      <p className="text-xs text-muted-foreground">Contacts whose consent is unknown or opted out are not included.</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onDone} disabled={!counts.data?.eligible}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** Feature 010 (US1, FR-004): a saved segment as the audience, with its counts now. */
function SegmentAudience({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const segments = useQuery({ queryKey: contacts010Keys.segments, queryFn: () => api<{ items: Segment[] }>('/segments') });
  const [segmentId, setSegmentId] = useState(campaign.audienceType === 'SEGMENT' ? (campaign.segmentId ?? '') : '');
  const count = useQuery({ queryKey: contacts010Keys.segmentCount(segmentId || 'none'), queryFn: () => api<SegmentCount>(`/segments/${segmentId}/count`), enabled: Boolean(segmentId) });
  const choose = useMutation({
    mutationFn: (id: string) => api<Campaign>(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { audienceType: 'SEGMENT', segmentId: id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) }),
    onError: toastError,
  });
  return (
    <div className="grid max-w-3xl gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor="audience-segment">Segment</Label>
        <NativeSelect
          id="audience-segment"
          value={segmentId}
          onChange={(e) => {
            setSegmentId(e.target.value);
            if (e.target.value) choose.mutate(e.target.value);
          }}
        >
          <option value="">Choose a segment</option>
          {(segments.data?.items ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          The members are worked out when the campaign launches. <Link href="/contacts/segments" className="underline">Manage segments</Link>
        </p>
      </div>
      {count.data ? (
        <div className="rounded-md border bg-muted/40 p-4 text-sm" data-testid="segment-audience-count">
          {formatNumber(count.data.count)} contacts match now · {formatNumber(count.data.marketable)} can get marketing messages
          {count.data.broken.length ? <p className="mt-1 text-destructive">The segment needs a fix before launch.</p> : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onDone} disabled={!segmentId || choose.isPending || !count.data?.count || Boolean(count.data?.broken.length)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** Step 2 (T109, T131): choose how recipients are selected. */
export function AudienceStep({ campaign, onBack, onDone }: { campaign: CampaignDetail; onBack: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AudienceMode>(campaign.audienceType);
  const switchMode = useMutation({
    mutationFn: (next: AudienceMode) => api<Campaign>(`/campaigns/${campaign.id}`, { method: 'PATCH', json: { audienceType: next } }),
    onSuccess: async (_saved, next) => {
      setMode(next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.campaign(campaign.id) });
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-6">
      <fieldset className="grid max-w-3xl gap-2 sm:grid-cols-4">
        <legend className="sr-only">Audience type</legend>
        {(campaign.audienceType === 'RETARGET' ? [{ value: 'RETARGET' as const, label: 'Retarget', hint: 'From an earlier campaign' }, ...MODES] : MODES).map((m) => (
          <label key={m.value} className={cn('cursor-pointer rounded-md border p-3 text-sm', mode === m.value && 'border-primary ring-1 ring-primary')}>
            <input
              type="radio"
              name="audience-type"
              className="sr-only"
              checked={mode === m.value}
              disabled={switchMode.isPending}
              onChange={() => (m.value === 'SEGMENT' ? setMode('SEGMENT') : switchMode.mutate(m.value))}
            />
            <div className="font-medium">{m.label}</div>
            <div className="text-xs text-muted-foreground">{m.hint}</div>
          </label>
        ))}
      </fieldset>
      {mode === 'UPLOAD' ? <UploadAudience campaign={campaign} onBack={onBack} onDone={onDone} /> : null}
      {mode === 'FILTER' ? <FilterAudience campaign={campaign} onBack={onBack} onDone={onDone} /> : null}
      {mode === 'ALL_OPTED_IN' ? <AllOptedInAudience onBack={onBack} onDone={onDone} /> : null}
      {mode === 'RETARGET' ? <RetargetAudience campaign={campaign} onBack={onBack} onDone={onDone} /> : null}
      {mode === 'SEGMENT' ? <SegmentAudience campaign={campaign} onBack={onBack} onDone={onDone} /> : null}
    </div>
  );
}
