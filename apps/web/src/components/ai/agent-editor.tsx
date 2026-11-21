'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentConfig, AgentProblem } from '@wbm/shared';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type AgentDetail } from '@/lib/ai';
import { api, ApiError } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import { AgentStatusBadge } from './agent-status-badge';
import { InstructionsTab } from './instructions-tab';
import { KnowledgeTab } from './knowledge-tab';
import { NumbersPanel } from './numbers-panel';
import { SkillsTab } from './skills-tab';
import { TestTab } from './test-tab';
import { UnansweredTab } from './unanswered-tab';
import { useAgentAutosave, type SaveStatus } from './use-agent-autosave';
import { VersionsTab } from './versions-tab';

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'All changes saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  invalid: 'Not saved',
  error: 'Not saved',
  conflict: 'Reloading…',
};

type Tab = 'instructions' | 'knowledge' | 'skills' | 'unanswered' | 'test' | 'versions';

type AgentMeta = Pick<AgentDetail, 'id' | 'name' | 'status' | 'publishedVersion' | 'numbers'>;
const metaOf = (agent: AgentDetail): AgentMeta => ({
  id: agent.id,
  name: agent.name,
  status: agent.status,
  publishedVersion: agent.publishedVersion,
  numbers: agent.numbers,
});

/** The tab that holds a problem's field. */
function tabOf(field: string | null): Tab | null {
  if (field === 'knowledge') return 'knowledge';
  if (field?.startsWith('skills')) return 'skills';
  return 'instructions';
}

/**
 * AI agent editor (004 T045): the draft saves itself by revision, Publish lists what blocks it, the
 * numbers it answers on, and the Instructions, Knowledge and Unanswered tabs.
 */
export function AgentEditor({ initial, onReload }: { initial: AgentDetail; onReload: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<AgentConfig>(initial.config);
  const [problems, setProblems] = useState<AgentProblem[]>(initial.problems);
  const [meta, setMeta] = useState<AgentMeta>(() => metaOf(initial));
  const [name, setName] = useState(initial.name);
  // The configuration customers meet, while it is still the one in the editor.
  const [publishedConfig, setPublishedConfig] = useState<AgentConfig | null>(
    initial.status === 'PUBLISHED' && !initial.hasUnpublishedChanges ? initial.config : null,
  );
  const [tab, setTab] = useState<Tab>('instructions');
  const refreshList = () => void queryClient.invalidateQueries({ queryKey: aiKeys.list });

  const autosave = useAgentAutosave({
    agentId: initial.id,
    config,
    initialConfig: initial.config,
    initialRevision: initial.draftRevision,
    onSaved: setProblems,
    onConflict: () => {
      toast.error('Someone else changed this agent. Loading the newest version…');
      void onReload();
    },
  });
  const change = (patch: Partial<AgentConfig>) => setConfig((current) => ({ ...current, ...patch }));
  const unpublishedChanges = meta.status === 'PUBLISHED' && config !== publishedConfig;

  const publish = useMutation({
    mutationFn: async (snapshot: AgentConfig) => {
      if (!(await autosave.flush())) throw new Error('UNSAVED');
      return { agent: await api<AgentDetail>(`/ai-agents/${initial.id}/publish`, { method: 'POST' }), snapshot };
    },
    onSuccess: ({ agent, snapshot }) => {
      setMeta(metaOf(agent));
      setPublishedConfig(snapshot);
      setProblems([]);
      toast.success(agent.publishedVersion ? `Published version ${agent.publishedVersion.number}` : 'Published');
      refreshList();
      void queryClient.invalidateQueries({ queryKey: aiKeys.versions(initial.id) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PUBLISH_BLOCKED') {
        const raw = error.extra?.problems;
        const list = Array.isArray(raw) ? (raw as AgentProblem[]) : [];
        setProblems(list);
        toast.error(list.length === 1 ? 'Fix 1 problem before publishing' : `Fix ${list.length} problems before publishing`);
      } else if (error instanceof Error && error.message === 'UNSAVED') {
        toast.error('The agent could not be saved, so it was not published');
      } else {
        toastError(error);
      }
    },
  });

  const unpublish = useMutation({
    mutationFn: () => api<AgentDetail>(`/ai-agents/${initial.id}/unpublish`, { method: 'POST' }),
    onSuccess: (agent) => {
      setMeta(metaOf(agent));
      setPublishedConfig(null);
      toast.success('Unpublished: the agent no longer answers customers');
      refreshList();
    },
    onError: toastError,
  });

  const rename = useMutation({
    mutationFn: (next: string) => api<AgentDetail>(`/ai-agents/${initial.id}`, { method: 'PATCH', json: { name: next } }),
    onSuccess: (agent) => {
      setMeta(metaOf(agent));
      setName(agent.name);
      refreshList();
    },
    onError: (error) => {
      setName(meta.name);
      toastError(error);
    },
  });

  function commitName() {
    const next = name.trim();
    if (!next || next === meta.name) setName(meta.name);
    else rename.mutate(next);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Link href="/ai-agents" className="text-sm text-muted-foreground hover:text-foreground">
            ← AI agents
          </Link>
          <Input
            aria-label="Agent name"
            value={name}
            maxLength={80}
            className="h-8 w-64 font-semibold"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <AgentStatusBadge agent={meta} />
          {unpublishedChanges && <span className="text-xs text-muted-foreground">Changes not published yet</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-xs text-muted-foreground" data-testid="save-status" title={autosave.detail ?? undefined}>
            {SAVE_LABEL[autosave.status]}
            {autosave.detail ? `: ${autosave.detail}` : ''}
          </span>
          {autosave.status === 'error' && (
            <Button size="sm" variant="ghost" onClick={() => void autosave.flush()}>
              Try again
            </Button>
          )}
          {meta.status === 'PUBLISHED' && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline">
                  Unpublish
                </Button>
              }
              title="Unpublish this agent?"
              description="It stops answering customers at once. Chats it is in stay open for your team."
              confirmLabel="Unpublish"
              confirmVariant="destructive"
              onConfirm={() => unpublish.mutateAsync().catch(() => undefined)}
            />
          )}
          <Button size="sm" onClick={() => publish.mutate(config)} disabled={publish.isPending}>
            {publish.isPending ? 'Publishing…' : meta.status === 'PUBLISHED' ? 'Publish changes' : 'Publish'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-w-0">
          <TabsList>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
            <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="unanswered">Unanswered</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
          </TabsList>
          <TabsContent value="instructions" className="pt-4">
            <InstructionsTab config={config} problems={problems} onChange={change} />
          </TabsContent>
          <TabsContent value="knowledge" className="pt-4">
            <KnowledgeTab agentId={initial.id} />
          </TabsContent>
          <TabsContent value="skills" className="pt-4">
            <SkillsTab config={config} problems={problems} onChange={change} />
          </TabsContent>
          <TabsContent value="unanswered" className="pt-4">
            <UnansweredTab agentId={initial.id} />
          </TabsContent>
          <TabsContent value="test" className="pt-4">
            <TestTab agentId={initial.id} testNumbers={initial.testNumbers} prepare={autosave.flush} />
          </TabsContent>
          <TabsContent value="versions" className="pt-4">
            <VersionsTab agentId={initial.id} prepare={autosave.flush} onRestored={onReload} />
          </TabsContent>
        </Tabs>
        <aside className="grid content-start gap-4">
          <ProblemsPanel problems={problems} onOpen={setTab} />
          <NumbersPanel
            agent={meta}
            onChanged={(agent) => {
              setMeta(metaOf(agent));
              refreshList();
            }}
          />
        </aside>
      </div>
    </div>
  );
}

/** What blocks publishing (FR-005); a problem opens the tab where it can be fixed. */
function ProblemsPanel({ problems, onOpen }: { problems: AgentProblem[]; onOpen: (tab: Tab) => void }) {
  return (
    <section aria-labelledby="ai-problems-title" className="grid gap-2 rounded-lg border bg-card p-3">
      <h2 id="ai-problems-title" className="text-sm font-semibold">
        {problems.length ? `Problems (${problems.length})` : 'Problems'}
      </h2>
      {problems.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-problems">
          Nothing blocks publishing.
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="problems">
          {problems.map((problem, i) => {
            const tab = tabOf(problem.field);
            return (
              <li key={`${problem.code}:${problem.field ?? ''}:${i}`}>
                {tab ? (
                  <button type="button" className="text-left text-sm text-destructive hover:underline" onClick={() => onOpen(tab)}>
                    {problem.message}
                  </button>
                ) : (
                  <span className="text-sm text-destructive">{problem.message}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
