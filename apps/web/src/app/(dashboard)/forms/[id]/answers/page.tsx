'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { formsKeys, type FormAnswer, type FormDetail } from '@/lib/forms';
import { Can } from '@/lib/permissions';

/** A form's answers, newest first, with the CSV export (feature 008 US7, FR-034). */
export default function FormAnswersPage() {
  return (
    <RequirePermission permission="forms.manage">
      <Answers />
    </RequirePermission>
  );
}

function Answers() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const form = useQuery({ queryKey: formsKeys.form(id), queryFn: () => api<FormDetail>(`/forms/${id}`) });
  const answers = useQuery({ queryKey: formsKeys.answers(id, page), queryFn: () => api<{ items: FormAnswer[]; total: number }>(`/forms/${id}/answers?page=${page}&pageSize=50`) });
  const keys = [...new Set((form.data?.draft.screens ?? []).flatMap((s) => s.fields.map((f) => f.key)))];
  return (
    <div className="grid max-w-6xl gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/forms/${id}`} className="text-sm text-muted-foreground hover:underline">
            ← {form.data?.name ?? 'Form'}
          </Link>
          <h1 className="text-2xl font-semibold">Answers</h1>
          <p className="text-sm text-muted-foreground">{answers.data ? `${answers.data.total} answers` : ' '}</p>
        </div>
        <Can permission="data.export">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/forms/${id}/answers/export.csv`} download>
              Export CSV
            </a>
          </Button>
        </Can>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="form-answers">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">When</th>
              <th className="p-2">Contact</th>
              <th className="p-2">Version</th>
              {keys.map((k) => (
                <th key={k} className="p-2 font-mono">
                  {k}
                </th>
              ))}
              <th className="p-2">Problems</th>
            </tr>
          </thead>
          <tbody>
            {(answers.data?.items ?? []).map((a) => (
              <tr key={a.id} className="border-t align-top">
                <td className="p-2 whitespace-nowrap">{new Date(a.submittedAt).toLocaleString()}</td>
                <td className="p-2">
                  {a.contactName ?? '—'}
                  <div className="text-xs text-muted-foreground">{a.phone}</div>
                </td>
                <td className="p-2">v{a.versionNumber}</td>
                {keys.map((k) => (
                  <td key={k} className="p-2">
                    {Array.isArray(a.answers[k]) ? (a.answers[k] as unknown[]).join(', ') : String(a.answers[k] ?? '')}
                  </td>
                ))}
                <td className="p-2 text-xs text-destructive">{a.problems.map((p) => `${p.fieldKey}: ${p.reason}`).join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {answers.data && answers.data.total > 50 ? (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page * 50 >= answers.data.total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
