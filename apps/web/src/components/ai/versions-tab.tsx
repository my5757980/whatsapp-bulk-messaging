'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type AgentDetail, type AgentVersion } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

interface VersionsTabProps {
  agentId: string;
  /** Saves pending edits before a restore replaces the draft. */
  prepare: () => Promise<boolean>;
  /** The editor starts again from the restored draft. */
  onRestored: () => Promise<unknown>;
}

/**
 * Every publish is a numbered version (004 T063, FR-005). Restoring copies a version into the draft;
 * customers keep meeting the published version until the next publish.
 */
export function VersionsTab({ agentId, prepare, onRestored }: VersionsTabProps) {
  const versions = useQuery({ queryKey: aiKeys.versions(agentId), queryFn: () => api<AgentVersion[]>(`/ai-agents/${agentId}/versions`) });
  const restore = useMutation({
    mutationFn: async (version: AgentVersion) => {
      await prepare();
      await api<AgentDetail>(`/ai-agents/${agentId}/versions/${version.id}/restore`, { method: 'POST' });
      return version;
    },
    onSuccess: async (version) => {
      toast.success(`Version ${version.number} is in the draft. Publish to give it to customers.`);
      await onRestored();
    },
    onError: toastError,
  });

  if (versions.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (versions.error) return <p className="text-sm text-destructive">{errorMessage(versions.error)}</p>;
  if (!versions.data?.length) return <p className="text-sm text-muted-foreground">No versions yet. Each publish keeps one here.</p>;

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">Restoring copies a version into the draft. Customers keep meeting the published version until you publish again.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>By</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.data.map((version) => (
            <TableRow key={version.id} data-testid="version-row">
              <TableCell className="font-medium">
                Version {version.number} {version.isCurrent && <Badge variant="success">Customers meet this one</Badge>}
              </TableCell>
              <TableCell className="text-sm">{formatDateTime(version.publishedAt)}</TableCell>
              <TableCell className="text-sm">{version.publishedBy?.name ?? '—'}</TableCell>
              <TableCell className="text-right">
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      Restore
                    </Button>
                  }
                  title={`Restore version ${version.number} into the draft?`}
                  description="The draft's instructions, skills and settings are replaced by this version's. Knowledge is shared and stays as it is."
                  confirmLabel="Restore"
                  onConfirm={() => restore.mutateAsync(version).catch(() => undefined)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
