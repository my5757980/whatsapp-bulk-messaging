'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, ImportJob } from '@/lib/types';

interface Preview {
  columns: string[];
  rows: string[][];
}

/** Reads the header and the first rows in the browser for column mapping and a preview. */
async function readPreview(file: File): Promise<Preview> {
  const raw = await file.slice(0, 64 * 1024).text();
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) => (header.split(d).length > header.split(best).length ? d : best), ',');
  const split = (line: string) => line.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  return { columns: split(header).map((c, i) => c || `column_${i + 1}`), rows: lines.slice(1, 6).map(split) };
}

function ColumnSelect({ id, label, value, onChange, columns, required }: { id: string; label: string; value: string; onChange: (v: string) => void; columns: string[]; required?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? 'Choose…' : 'Not imported'}</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** Contacts import with column mapping, preview, opt-in confirmation and error report (T129). */
export default function ImportContactsPage() {
  return (
    <RequirePermission permission="contacts.manage">
      <ImportContacts />
    </RequirePermission>
  );
}

function ImportContacts() {
  const queryClient = useQueryClient();
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [tags, setTags] = useState('');
  const [optInSource, setOptInSource] = useState('');
  const [attributeColumns, setAttributeColumns] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const job = useQuery({
    queryKey: ['import', jobId],
    queryFn: () => api<ImportJob>(`/imports/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'QUEUED' || q.state.data.status === 'PROCESSING') ? 1000 : false),
  });
  const done = job.data?.status === 'COMPLETED';
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['contacts'] });
  }, [done, queryClient]);

  const start = useMutation({
    mutationFn: () => {
      const mapping = {
        phone,
        ...(name ? { name } : {}),
        ...(tags ? { tags } : {}),
        ...(optInSource ? { optInSource } : {}),
        attributes: Object.fromEntries(Object.entries(attributeColumns).filter(([, column]) => column)),
      };
      const form = new FormData();
      form.set('file', file as File);
      form.set('mapping', JSON.stringify(mapping));
      if (confirmed) form.set('optInSourceNote', note.trim());
      return api<ImportJob>('/imports', { method: 'POST', body: form });
    },
    onSuccess: (created) => setJobId(created.id),
    onError: (e) => setError(errorMessage(e)),
  });

  async function chooseFile(next: File | null) {
    setFile(next);
    setError(null);
    setJobId(null);
    if (!next) return setPreview(null);
    const p = await readPreview(next);
    setPreview(p);
    const find = (re: RegExp) => p.columns.find((c) => re.test(c)) ?? '';
    setPhone(find(/phone|mobile|whatsapp|number/i));
    setName(find(/name/i));
    setTags(find(/tag|label/i));
    setOptInSource('');
    setAttributeColumns(Object.fromEntries((attributes.data ?? []).map((a) => [a.key, p.columns.includes(a.key) ? a.key : ''])));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!file) return setError('Choose a CSV file.');
    if (!phone) return setError('Choose the column that holds phone numbers.');
    if (confirmed && note.trim().length < 3) return setError('Describe where and how the contacts opted in.');
    start.mutate();
  }

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <Link href="/contacts" className="text-sm text-muted-foreground hover:underline">
          ← Contacts
        </Link>
        <h1 className="text-2xl font-semibold">Import contacts</h1>
        <p className="text-sm text-muted-foreground">Existing contacts are matched by phone number and updated; new numbers are added. Opted-out contacts stay opted out.</p>
      </div>
      <form onSubmit={submit} className="grid gap-6">
        <div className="grid gap-1.5">
          <Label htmlFor="import-file">Contacts file (CSV, up to 50 MB)</Label>
          <Input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} />
        </div>
        {preview ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Column mapping</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <ColumnSelect id="map-phone" label="Phone number column" value={phone} onChange={setPhone} columns={preview.columns} required />
                <ColumnSelect id="map-name" label="Name column" value={name} onChange={setName} columns={preview.columns} />
                <ColumnSelect id="map-tags" label="Tags column" value={tags} onChange={setTags} columns={preview.columns} />
                <ColumnSelect id="map-optin" label="Opt-in source column" value={optInSource} onChange={setOptInSource} columns={preview.columns} />
                {(attributes.data ?? []).map((a) => (
                  <ColumnSelect
                    key={a.key}
                    id={`map-attr-${a.key}`}
                    label={`Attribute ${a.key}`}
                    value={attributeColumns[a.key] ?? ''}
                    onChange={(v) => setAttributeColumns((current) => ({ ...current, [a.key]: v }))}
                    columns={preview.columns}
                  />
                ))}
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Tags can hold several values separated by ; or ,. A non-empty opt-in source marks that row as opted in and is kept as the consent note.
                  {attributes.data?.length ? '' : ' Define custom attributes in Settings to import them.'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview (first rows)</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {preview.columns.map((c) => (
                        <TableHead key={c}>{c}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row, i) => (
                      <TableRow key={i}>
                        {preview.columns.map((c, j) => (
                          <TableCell key={c} className="text-xs">
                            {row[j] ?? ''}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <div className="grid gap-3 rounded-md border p-4">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I confirm every contact in this file opted in to receive WhatsApp messages from us.</span>
              </label>
              {confirmed ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="import-note">Where did they opt in?</Label>
                  <Input id="import-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Loyalty sign-up form, 2026" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Without confirmation, new contacts are added with consent Unknown (they can receive utility messages, not marketing).</p>
              )}
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={!preview || start.isPending || job.data?.status === 'PROCESSING' || job.data?.status === 'QUEUED'}>
            {start.isPending ? 'Uploading…' : 'Start import'}
          </Button>
        </div>
      </form>

      {job.data ? (
        <div className="grid gap-2 rounded-md border bg-muted/40 p-4 text-sm" data-testid="import-summary">
          {job.data.status === 'QUEUED' || job.data.status === 'PROCESSING' ? <div>Importing…</div> : null}
          {job.data.status === 'FAILED' ? <div className="text-destructive">The import failed: {job.data.error}</div> : null}
          {done ? (
            <>
              <div className="font-medium">{formatNumber(job.data.totalRows)} rows processed</div>
              <div>
                {formatNumber(job.data.createdCount)} new · {formatNumber(job.data.updatedCount)} updated · {formatNumber(job.data.skippedCount)} duplicates ·{' '}
                {formatNumber(job.data.errorCount)} invalid
              </div>
              {job.data.hasErrorReport ? (
                <a className="text-primary underline" href={`/api/imports/${job.data.id}/errors`} download>
                  Download error report
                </a>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
