'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { starterByKey, type StarterAttribute } from '@wbm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FlowStatusBadge } from '@/components/flows/flow-status-badge';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { flowKeys, type FlowDetail, type FlowSummary } from '@/lib/flows';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition } from '@/lib/types';

/** Chatbot flows list (003 T026): status, published version, triggers and the last 7 days. */
export default function FlowsPage() {
  return (
    <RequirePermission permission="flows.manage">
      <FlowsList />
    </RequirePermission>
  );
}

function FlowsList() {
  const queryClient = useQueryClient();
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: flowKeys.list });
  const duplicate = useMutation({
    mutationFn: (id: string) => api<FlowDetail>(`/flows/${id}/duplicate`, { method: 'POST' }),
    onSuccess: (flow) => {
      toast.success(`Created "${flow.name}"`);
      refresh();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/flows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Flow deleted');
      refresh();
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Chatbot flows</h1>
          <p className="text-sm text-muted-foreground">
            Automatic conversations that start when a customer sends a keyword. Customers only meet published flows.
          </p>
        </div>
        <NewFlowDialog />
      </div>
      <Card>
        <CardContent className="p-0">
          {flows.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : flows.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(flows.error)}</p>
          ) : !flows.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No flows yet. Create one to answer customers automatically.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Starts with</TableHead>
                  <TableHead>Last 7 days</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flows.data.map((flow) => (
                  <TableRow key={flow.id} data-testid="flow-row">
                    <TableCell>
                      <Link href={`/flows/${flow.id}`} className="font-medium hover:underline">
                        {flow.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {flow.draftUpdatedAt ? `Edited ${formatDateTime(flow.draftUpdatedAt)}` : 'Not edited yet'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <FlowStatusBadge flow={flow} />
                      {flow.hasUnpublishedChanges && <div className="mt-1 text-xs text-muted-foreground">Changes not published yet</div>}
                    </TableCell>
                    <TableCell>
                      {flow.triggers.length ? (
                        <ul className="grid gap-0.5 text-xs">
                          {flow.triggers.map((trigger, i) => (
                            <li key={i}>{trigger}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-muted-foreground">No trigger</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {flow.last7Days ? `${flow.last7Days.started} started · ${flow.last7Days.completed} completed` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => duplicate.mutate(flow.id)} disabled={duplicate.isPending}>
                          Duplicate
                        </Button>
                        {flow.status === 'PUBLISHED' ? (
                          <Button size="sm" variant="outline" disabled title="Unpublish the flow before deleting it">
                            Delete
                          </Button>
                        ) : (
                          <ConfirmDialog
                            trigger={
                              <Button size="sm" variant="outline">
                                Delete
                              </Button>
                            }
                            title={`Delete "${flow.name}"?`}
                            description="The flow and its drafts are removed. Past chats keep the messages it sent."
                            confirmLabel="Delete flow"
                            confirmVariant="destructive"
                            onConfirm={() => remove.mutateAsync(flow.id).catch(() => undefined)}
                          />
                        )}
                      </div>
                    </TableCell>
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

interface StarterSummary {
  key: string;
  name: string;
  description: string;
  stepCount: number;
  attributes: string[];
}

/** New flow, empty or from a starter written by us (003 T081, FR-037), with the offer to create missing attributes. */
function NewFlowDialog() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [starterKey, setStarterKey] = useState('');
  const [created, setCreated] = useState<{ id: string; missing: StarterAttribute[] } | null>(null);
  const starters = useQuery({ queryKey: ['flow-starters'], queryFn: () => api<StarterSummary[]>('/flow-starters'), enabled: open });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes'), enabled: open && Boolean(starterKey) });
  const chosen = starters.data?.find((s) => s.key === starterKey);

  const create = useMutation({
    mutationFn: () => api<FlowDetail>('/flows', { method: 'POST', json: { name: name.trim(), ...(starterKey ? { starterKey } : {}) } }),
    onSuccess: (flow) => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.list });
      const existing = new Set((attributes.data ?? []).map((a) => a.key));
      const missing = (starterByKey(starterKey)?.attributes ?? []).filter((a) => !existing.has(a.key));
      if (missing.length) setCreated({ id: flow.id, missing });
      else router.push(`/flows/${flow.id}`);
    },
    onError: toastError,
  });
  const createAttributes = useMutation({
    mutationFn: async (missing: StarterAttribute[]) => {
      for (const a of missing) {
        try {
          await api('/attributes', { method: 'POST', json: { key: a.key, label: a.label, type: a.type } });
        } catch (error) {
          // Someone created it meanwhile: that is fine.
          if (!(error instanceof ApiError && error.status === 409)) throw error;
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attributes });
      toast.success('Attributes created');
      if (created) router.push(`/flows/${created.id}`);
    },
    onError: toastError,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New flow</Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create the attributes this starter uses?</DialogTitle>
              <DialogDescription>The starter saves answers to these contact attributes, which do not exist yet. Publishing needs them.</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1 text-sm" data-testid="missing-attributes">
              {created.missing.map((a) => (
                <li key={a.key}>
                  {a.label} <span className="text-muted-foreground">({a.key}, {a.type.toLowerCase()})</span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => router.push(`/flows/${created.id}`)}>
                Open without them
              </Button>
              <Button onClick={() => createAttributes.mutate(created.missing)} disabled={createAttributes.isPending}>
                {createAttributes.isPending ? 'Creating…' : 'Create attributes and open'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>New flow</DialogTitle>
              <DialogDescription>Give it a name your team will recognise. You can change it later.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1">
              <Label htmlFor="flow-name">Flow name</Label>
              <Input id="flow-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="flow-starter">Start from</Label>
              <NativeSelect id="flow-starter" value={starterKey} onChange={(e) => setStarterKey(e.target.value)}>
                <option value="">An empty flow</option>
                {starters.data?.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name} ({s.stepCount} steps)
                  </option>
                ))}
              </NativeSelect>
              {chosen && <p className="text-xs text-muted-foreground">{chosen.description}</p>}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim() || create.isPending || (Boolean(starterKey) && attributes.isLoading)}>
                {create.isPending ? 'Creating…' : 'Create flow'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
