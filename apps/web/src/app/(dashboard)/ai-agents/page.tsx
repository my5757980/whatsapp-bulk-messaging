'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AgentStatusBadge } from '@/components/ai/agent-status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type AgentDetail, type AgentStarterSummary, type AgentSummary, type StarterAttributeOffer } from '@/lib/ai';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';

/** AI agents list (004 T044): status, numbers, the last 7 days, duplicate and delete. */
export default function AiAgentsPage() {
  return (
    <RequirePermission permission="ai.manage">
      <AgentsList />
    </RequirePermission>
  );
}

function AgentsList() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: aiKeys.list, queryFn: () => api<AgentSummary[]>('/ai-agents') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: aiKeys.list });
  const duplicate = useMutation({
    mutationFn: (agent: AgentSummary) => api<AgentDetail>(`/ai-agents/${agent.id}/duplicate`, { method: 'POST', json: { name: `${agent.name} (copy)`.slice(0, 80) } }),
    onSuccess: (agent) => {
      toast.success(`Created "${agent.name}"`);
      refresh();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/ai-agents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Agent deleted');
      refresh();
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">AI agents</h1>
          <p className="text-sm text-muted-foreground">
            Assistants that answer customers from your instructions and knowledge, and hand chats to your team when needed.
          </p>
        </div>
        <NewAgentDialog />
      </div>
      <Card>
        <CardContent className="p-0">
          {agents.isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : agents.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(agents.error)}</p>
          ) : !agents.data?.length ? (
            <p className="p-6 text-sm text-muted-foreground">No agents yet. Create one to answer customers automatically.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Answers on</TableHead>
                  <TableHead>Last 7 days</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.data.map((agent) => (
                  <TableRow key={agent.id} data-testid="agent-row">
                    <TableCell>
                      <Link href={`/ai-agents/${agent.id}`} className="font-medium hover:underline">
                        {agent.name}
                      </Link>
                      {agent.hasUnpublishedChanges && <div className="text-xs text-muted-foreground">Changes not published yet</div>}
                    </TableCell>
                    <TableCell>
                      <AgentStatusBadge agent={agent} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {agent.numbers.length ? agent.numbers.map((n) => n.displayPhone).join(', ') : <span className="text-muted-foreground">No number</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {agent.last7Days.replies} replies · {agent.last7Days.handedOver} handed over
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => duplicate.mutate(agent)} disabled={duplicate.isPending}>
                          Duplicate
                        </Button>
                        {agent.status === 'PUBLISHED' ? (
                          <Button size="sm" variant="outline" disabled title="Unpublish the agent before deleting it">
                            Delete
                          </Button>
                        ) : (
                          <ConfirmDialog
                            trigger={
                              <Button size="sm" variant="outline">
                                Delete
                              </Button>
                            }
                            title={`Delete "${agent.name}"?`}
                            description="The agent, its knowledge and its secrets are removed. Past chats keep the replies it sent."
                            confirmLabel="Delete agent"
                            confirmVariant="destructive"
                            onConfirm={() => remove.mutateAsync(agent.id).catch(() => undefined)}
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

/** A new agent, empty or from a starter written by us (T095, FR-040), with the offer to create missing attributes (FR-041). */
function NewAgentDialog() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [starterKey, setStarterKey] = useState('');
  const [created, setCreated] = useState<{ id: string; missing: StarterAttributeOffer[] } | null>(null);
  const starters = useQuery({ queryKey: aiKeys.starters, queryFn: () => api<AgentStarterSummary[]>('/ai-agent-starters'), enabled: open });
  const chosen = starters.data?.find((s) => s.key === starterKey);

  const create = useMutation({
    mutationFn: () => api<AgentDetail>('/ai-agents', { method: 'POST', json: { name: name.trim(), ...(starterKey ? { starterKey } : {}) } }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.list });
      const missing = (chosen?.suggestedAttributes ?? []).filter((a) => !a.exists);
      if (missing.length) setCreated({ id: agent.id, missing });
      else router.push(`/ai-agents/${agent.id}`);
    },
    onError: toastError,
  });
  const createAttributes = useMutation({
    mutationFn: async (missing: StarterAttributeOffer[]) => {
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
      void queryClient.invalidateQueries({ queryKey: aiKeys.starters });
      toast.success('Attributes created');
      if (created) router.push(`/ai-agents/${created.id}`);
    },
    onError: toastError,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreated(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>New agent</Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create the attributes this starter uses?</DialogTitle>
              <DialogDescription>The agent remembers what customers tell it in these contact attributes, which do not exist yet. Publishing needs them.</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1 text-sm" data-testid="missing-attributes">
              {created.missing.map((a) => (
                <li key={a.key}>
                  {a.label} <span className="text-muted-foreground">({a.key}, {a.type.toLowerCase()})</span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => router.push(`/ai-agents/${created.id}`)}>
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
              <DialogTitle>New AI agent</DialogTitle>
              <DialogDescription>Give it a name your team will recognise. You can change everything later.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Sales assistant" autoFocus />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="agent-starter">Start from</Label>
              <NativeSelect id="agent-starter" value={starterKey} onChange={(e) => setStarterKey(e.target.value)}>
                <option value="">An empty agent</option>
                {starters.data?.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
              {chosen ? (
                <p className="text-xs text-muted-foreground" data-testid="starter-description">
                  {chosen.description} It comes with example answers marked “Replace me”: replace or remove them before publishing.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create agent'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
