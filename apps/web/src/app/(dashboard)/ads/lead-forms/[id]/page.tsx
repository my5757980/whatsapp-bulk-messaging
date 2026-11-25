'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adsKeys, type AdLead, type AdLeadForm } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Can } from '@/lib/permissions';

const PAGE_SIZE = 50;
const STATUS_LABEL = { PROCESSED: 'Contact saved', NO_PHONE: 'No phone', INVALID_PHONE: 'Phone not valid', FAILED: 'Failed' } as const;

/** One lead form with its leads (feature 007 US7, FR-038, FR-039); phones masked without phones.full. */
export default function LeadFormPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <LeadForm />
    </RequirePermission>
  );
}

function LeadForm() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const form = useQuery({ queryKey: [...adsKeys.leadForms, id], queryFn: () => api<AdLeadForm>(`/ads/lead-forms/${id}`) });
  const leads = useQuery({
    queryKey: adsKeys.leads(id, page),
    queryFn: () => api<{ items: AdLead[]; total: number }>(`/ads/lead-forms/${id}/leads?page=${page}&pageSize=${PAGE_SIZE}`),
    refetchInterval: 15_000,
  });
  const f = form.data;
  if (form.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!f) return <p className="text-sm text-muted-foreground">Lead form not found.</p>;
  const total = leads.data?.total ?? 0;

  return (
    <div className="grid max-w-4xl gap-6">
      <div>
        <Link href="/ads/lead-forms" className="text-sm text-muted-foreground hover:underline">
          ← Lead forms
        </Link>
        <h1 className="text-2xl font-semibold">{f.name}</h1>
        <p className="text-sm text-muted-foreground">
          {f.leads} lead{f.leads === 1 ? '' : 's'} · last {formatDateTime(f.lastLeadAt)} · consent text: &quot;{f.consentText}&quot;
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Leads</CardTitle>
          <CardDescription>Leads arrive within seconds; any missed by Meta are read again every 15 minutes.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {leads.data?.items.length ? (
            <Table data-testid="leads">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>WhatsApp consent</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.data.items.map((l) => (
                  <TableRow key={l.id} data-testid="lead-row">
                    <TableCell>{l.answers?.full_name ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{l.phone ?? '—'}</TableCell>
                    <TableCell>{l.consent ? <Badge variant="success">Yes</Badge> : <Badge variant="outline">No</Badge>}</TableCell>
                    <TableCell>{STATUS_LABEL[l.status]}</TableCell>
                    <TableCell>{formatDateTime(l.submittedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : leads.isSuccess ? (
            <p className="text-sm text-muted-foreground">No leads yet.</p>
          ) : null}
          {total > PAGE_SIZE ? (
            <div className="flex items-center gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              <Button variant="outline" size="sm" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null}
          <Can permission="data.export">
            <Button asChild variant="outline" className="justify-self-start">
              <a href={`/api/ads/lead-forms/${id}/leads/export`} download>
                Export CSV
              </a>
            </Button>
          </Can>
        </CardContent>
      </Card>
    </div>
  );
}
