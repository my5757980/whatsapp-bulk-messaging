'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import type { FlowDetail } from '@/lib/flows';
import { formatDateTime } from '@/lib/format';

interface FlowVersion {
  id: string;
  kind: 'PUBLISHED' | 'REVISION';
  number: number | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  current?: boolean;
}

/**
 * Published versions and the last 20 autosaves (003 T072, FR-007). Restoring copies one into the
 * draft; the server keeps the draft it replaces as an autosave, so a restore can be undone.
 */
export function VersionsDrawer({ flowId, prepare, onRestored }: { flowId: string; prepare: () => Promise<boolean>; onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  const versions = useQuery({ queryKey: ['flows', 'versions', flowId], queryFn: () => api<FlowVersion[]>(`/flows/${flowId}/versions`), enabled: open });
  const restore = useMutation({
    mutationFn: async (versionId: string) => {
      // Unsaved edits are saved first, so they are kept as the newest autosave.
      if (!(await prepare())) throw new Error('The draft could not be saved, so nothing was restored');
      return api<FlowDetail>(`/flows/${flowId}/versions/${versionId}/restore`, { method: 'POST' });
    },
    onSuccess: () => {
      toast.success('Restored into the draft');
      setOpen(false);
      onRestored();
    },
    onError: (error) => (error instanceof Error && !('status' in error) ? toast.error(error.message) : toastError(error)),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Versions
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>Published versions and the last 20 autosaves. Restoring copies one into the draft; publish it to make it live.</DialogDescription>
        </DialogHeader>
        {versions.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <ul className="grid max-h-96 gap-1 overflow-y-auto" data-testid="versions">
          {versions.data?.map((version) => (
            <li key={version.id} className="flex items-center justify-between gap-2 border-b py-1 text-sm last:border-b-0">
              <span className="min-w-0">
                <span className="font-medium">{version.kind === 'PUBLISHED' ? `Version ${version.number}` : 'Autosave'}</span>
                {version.current && <span className="ml-1 rounded-full bg-success px-2 py-0.5 text-xs text-primary-foreground">live</span>}
                <span className="block text-xs text-muted-foreground">
                  {formatDateTime(version.createdAt)}
                  {version.createdBy ? ` · ${version.createdBy.name}` : ''}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => restore.mutate(version.id)} disabled={restore.isPending}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
