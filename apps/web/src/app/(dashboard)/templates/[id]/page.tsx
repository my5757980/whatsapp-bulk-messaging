'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TemplatePreview, componentsToDraft } from '@/components/templates/template-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, templateStatusVariant, titleCase } from '@/lib/format';
import { Can } from '@/lib/permissions';
import type { Template } from '@/lib/types';

const POLL_MS = 10_000;

/** Template detail: status, rejection reason, variables, duplicate and delete (T143). */
export default function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const template = useQuery({
    queryKey: ['template', id],
    queryFn: () => api<Template>(`/templates/${id}`),
    // Meta reviews templates asynchronously; refresh until a decision arrives.
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? POLL_MS : false),
  });

  if (template.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (template.error || !template.data) return <p className="text-sm text-destructive">{errorMessage(template.error)}</p>;
  const t = template.data;

  return (
    <div className="grid max-w-5xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/templates" className="text-sm text-muted-foreground hover:underline">
            ← Templates
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{t.name}</h1>
            <Badge variant={templateStatusVariant[t.status]} data-testid="template-status">
              {titleCase(t.status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {titleCase(t.category)} · {t.language} · last checked {formatDateTime(t.lastSyncedAt)}
            {t.status === 'PENDING' ? ' · checking for Meta’s decision every 10 seconds' : ''}
          </p>
        </div>
        <Can permission="templates.manage">
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/templates/new?from=${t.id}`}>Duplicate &amp; edit</Link>
            </Button>
            {t.status !== 'DELETED' ? (
              <ConfirmDialog
                trigger={<Button variant="destructive">Delete</Button>}
                title={`Delete ${t.name}?`}
                description="The template is deleted in WhatsApp too (this language only). Campaigns that already sent it keep their history."
                confirmLabel="Delete template"
                confirmVariant="destructive"
                onConfirm={() =>
                  api(`/templates/${t.id}`, { method: 'DELETE' })
                    .then(() => {
                      toast.success('Template deleted');
                      void queryClient.invalidateQueries({ queryKey: ['templates'] });
                      router.replace('/templates');
                    })
                    .catch(toastError)
                }
              />
            ) : null}
          </div>
        </Can>
      </div>

      {t.status === 'REJECTED' ? (
        <div role="status" className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm">
          <div className="font-medium">Meta rejected this template</div>
          <div>Reason: {t.rejectionReason ? titleCase(t.rejectionReason) : 'not given'}. Duplicate it, fix the content and submit again.</div>
        </div>
      ) : null}
      {t.status === 'PAUSED' || t.status === 'DISABLED' ? (
        <div role="status" className="rounded-md border border-warning bg-warning/10 p-4 text-sm">
          Meta {t.status === 'PAUSED' ? 'paused' : 'disabled'} this template, usually because of low quality feedback. Running campaigns that use it were paused.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Variables</CardTitle>
          </CardHeader>
          <CardContent>
            {t.variables.length ? (
              <ul className="grid gap-2 text-sm">
                {t.variables.map((v) => (
                  <li key={v.key} className="flex justify-between rounded-md border px-3 py-2">
                    <span className="font-mono">{v.key}</span>
                    <span className="text-muted-foreground">{v.example || '—'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">This template has no variables.</p>
            )}
          </CardContent>
        </Card>
        <TemplatePreview draft={componentsToDraft(t.components)} />
      </div>
    </div>
  );
}
