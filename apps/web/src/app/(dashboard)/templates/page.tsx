'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, templateStatusVariant, titleCase } from '@/lib/format';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { Template } from '@/lib/types';

/** Templates list with Meta sync (T108) and links to the editor and details (US3). */
export default function TemplatesPage() {
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: queryKeys.templates(), queryFn: () => api<Template[]>('/templates') });
  const sync = useMutation({
    mutationFn: () => api<{ created: number; updated: number }>('/templates/sync', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`Templates synced: ${r.created} new, ${r.updated} updated`);
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-sm text-muted-foreground">Message templates approved by Meta can be used in campaigns.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw className="h-4 w-4" /> {sync.isPending ? 'Syncing…' : 'Sync from Meta'}
          </Button>
          <Button variant="outline" asChild>
            <Link href="/templates/samples">Samples</Link>
          </Button>
          <Can permission="templates.manage">
            <Button asChild>
              <Link href="/templates/new">New template</Link>
            </Button>
          </Can>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {templates.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : templates.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(templates.error)}</p>
          ) : !templates.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No templates yet. Connect a number, then sync from Meta.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Variables</TableHead>
                  <TableHead>Last synced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.data.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/templates/${t.id}`} className="font-medium hover:underline">
                        {t.name}
                      </Link>
                      <div className="max-w-md truncate text-xs text-muted-foreground">
                        {t.components.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? ''}
                      </div>
                    </TableCell>
                    <TableCell>{t.language}</TableCell>
                    <TableCell>{titleCase(t.category)}</TableCell>
                    <TableCell>
                      <Badge variant={templateStatusVariant[t.status]}>{titleCase(t.status)}</Badge>
                      {t.rejectionReason ? <div className="mt-1 text-xs text-destructive">{t.rejectionReason}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t.variables.map((v) => v.key).join(', ') || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(t.lastSyncedAt)}</TableCell>
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
