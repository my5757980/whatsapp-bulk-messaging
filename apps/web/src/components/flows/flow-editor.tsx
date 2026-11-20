'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FLOW_LIMITS, type FlowGraph, type FlowStep, type Problem, type StepType } from '@wbm/shared';
import { useReactFlow, type XYPosition } from '@xyflow/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import { addStep, flowKeys, PALETTE, pasteStep, removeStep, STEP_LABELS, type FlowDetail } from '@/lib/flows';
import { FlowCanvas } from './flow-canvas';
import { FlowStatusBadge } from './flow-status-badge';
import { ProblemsPanel } from './problems-panel';
import { SecretsPanel, type FlowSecret } from './secrets-panel';
import { StepForm } from './steps/step-form';
import { TriggerPanel } from './trigger-panel';
import { useDraftAutosave, type SaveStatus } from './use-draft-autosave';
import { useGraphHistory } from './use-graph-history';

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'All changes saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  invalid: 'Not saved',
  error: 'Not saved',
  conflict: 'Reloading…',
};

type FlowMeta = Pick<FlowDetail, 'name' | 'status' | 'publishedVersion'>;
const metaOf = (flow: FlowDetail): FlowMeta => ({ name: flow.name, status: flow.status, publishedVersion: flow.publishedVersion });

/** Keyboard shortcuts stay out of the way while the member types in a field. */
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);
}

/**
 * The flow editor (003 T027, FR-001–FR-005): canvas, step forms, keyword triggers, autosave with
 * conflict reload, 20-step undo, copy and paste, problems linked to steps, publish and unpublish.
 */
export function FlowEditor({ initial, onReload }: { initial: FlowDetail; onReload: () => Promise<void> }) {
  const queryClient = useQueryClient();
  const viewport = useReactFlow();
  const { graph, change, undo, redo, canUndo, canRedo } = useGraphHistory(initial.graph);
  const [meta, setMeta] = useState<FlowMeta>(() => metaOf(initial));
  const [name, setName] = useState(initial.name);
  const [problems, setProblems] = useState<Problem[]>(initial.problems ?? []);
  const [secrets, setSecrets] = useState<FlowSecret[]>(initial.secrets);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The graph customers meet, when the editor holds it (drives the "not published yet" hint).
  const [publishedGraph, setPublishedGraph] = useState<FlowGraph | null>(
    initial.status === 'PUBLISHED' && !initial.hasUnpublishedChanges ? initial.graph : null,
  );
  const canvasBox = useRef<HTMLDivElement>(null);
  const clipboard = useRef<FlowStep | null>(null);

  const autosave = useDraftAutosave({
    flowId: initial.id,
    graph,
    initialGraph: initial.graph,
    initialRevision: initial.draftRevision,
    onSaved: setProblems,
    onConflict: () => {
      toast.error('Someone else changed this flow. Loading the newest version…');
      void onReload();
    },
  });

  const selected = graph.steps.find((s) => s.id === selectedId) ?? null;
  const unpublishedChanges = meta.status === 'PUBLISHED' && graph !== publishedGraph;
  const refreshList = () => void queryClient.invalidateQueries({ queryKey: flowKeys.list });

  function roomForStep(): boolean {
    if (graph.steps.length < FLOW_LIMITS.steps) return true;
    toast.error(`A flow can have up to ${FLOW_LIMITS.steps} steps`);
    return false;
  }

  /** New steps go to the right of the selected step, else near the middle of the visible canvas. */
  function placeForNewStep(): XYPosition {
    if (selected) return { x: selected.position.x + 320, y: selected.position.y };
    const box = canvasBox.current?.getBoundingClientRect();
    const centre = box ? viewport.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 3 }) : { x: 0, y: 0 };
    const nudge = (graph.steps.length % 6) * 24;
    return { x: Math.round(centre.x + nudge), y: Math.round(centre.y + nudge) };
  }

  /** Pans (keeping the zoom) when a new step would be outside the visible canvas. */
  function bringIntoView(at: XYPosition) {
    const box = canvasBox.current?.getBoundingClientRect();
    if (!box) return;
    const topLeft = viewport.screenToFlowPosition({ x: box.left, y: box.top });
    const bottomRight = viewport.screenToFlowPosition({ x: box.right, y: box.bottom });
    const visible = at.x >= topLeft.x && at.x + 240 <= bottomRight.x && at.y >= topLeft.y && at.y + 120 <= bottomRight.y;
    if (!visible) void viewport.setCenter(at.x + 120, at.y + 60, { zoom: viewport.getZoom(), duration: 200 });
  }

  function add(type: StepType) {
    if (!roomForStep()) return;
    const at = placeForNewStep();
    const result = addStep(graph, type, at);
    change(() => result.graph);
    setSelectedId(result.id);
    bringIntoView(at);
  }

  const paste = useCallback(
    (source: FlowStep) => {
      if (graph.steps.length >= FLOW_LIMITS.steps) {
        toast.error(`A flow can have up to ${FLOW_LIMITS.steps} steps`);
        return;
      }
      const result = pasteStep(graph, source);
      change(() => result.graph);
      setSelectedId(result.id);
    },
    [graph, change],
  );

  function deleteStep(id: string) {
    change((g) => removeStep(g, id));
    setSelectedId(null);
  }

  function focusStep(id: string) {
    setSelectedId(id);
    void viewport.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2 });
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      } else if (key === 'c' && selected) {
        clipboard.current = selected;
      } else if (key === 'v' && clipboard.current) {
        event.preventDefault();
        paste(clipboard.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, paste, selected]);

  const publish = useMutation({
    mutationFn: async (snapshot: FlowGraph) => {
      if (!(await autosave.flush())) throw new Error('UNSAVED');
      return { flow: await api<FlowDetail>(`/flows/${initial.id}/publish`, { method: 'POST' }), snapshot };
    },
    onSuccess: ({ flow, snapshot }) => {
      setMeta(metaOf(flow));
      setPublishedGraph(snapshot);
      setProblems([]);
      toast.success(flow.publishedVersion ? `Published version ${flow.publishedVersion.number}` : 'Published');
      refreshList();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PUBLISH_BLOCKED') {
        const raw = error.extra?.problems;
        const list = Array.isArray(raw) ? (raw as Problem[]) : [];
        setProblems(list);
        toast.error(list.length === 1 ? 'Fix 1 problem before publishing' : `Fix ${list.length} problems before publishing`);
      } else if (error instanceof Error && error.message === 'UNSAVED') {
        toast.error('The flow could not be saved, so it was not published');
      } else {
        toastError(error);
      }
    },
  });

  const unpublish = useMutation({
    mutationFn: () => api<FlowDetail>(`/flows/${initial.id}/unpublish`, { method: 'POST' }),
    onSuccess: (flow) => {
      setMeta(metaOf(flow));
      setPublishedGraph(null);
      toast.success('Unpublished: its keywords no longer start it');
      refreshList();
    },
    onError: toastError,
  });

  const rename = useMutation({
    mutationFn: (next: string) => api<FlowDetail>(`/flows/${initial.id}`, { method: 'PATCH', json: { name: next } }),
    onSuccess: (flow) => {
      setMeta(metaOf(flow));
      setName(flow.name);
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
          <Link href="/flows" className="text-sm text-muted-foreground hover:text-foreground">
            ← Flows
          </Link>
          <Input
            aria-label="Flow name"
            value={name}
            maxLength={80}
            className="h-8 w-64 font-semibold"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <FlowStatusBadge flow={meta} />
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
          <Button size="sm" variant="outline" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            Undo
          </Button>
          <Button size="sm" variant="outline" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">
            Redo
          </Button>
          {meta.status === 'PUBLISHED' && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline">
                  Unpublish
                </Button>
              }
              title="Unpublish this flow?"
              description="Its keywords stop starting it at once. Customers in the middle of it leave the flow at their next message."
              confirmLabel="Unpublish"
              confirmVariant="destructive"
              onConfirm={() => unpublish.mutateAsync().catch(() => undefined)}
            />
          )}
          <Button size="sm" onClick={() => publish.mutate(graph)} disabled={publish.isPending}>
            {publish.isPending ? 'Publishing…' : meta.status === 'PUBLISHED' ? 'Publish changes' : 'Publish'}
          </Button>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
        <aside className="grid content-start gap-4">
          <section aria-labelledby="palette-title" className="grid gap-2 rounded-lg border bg-card p-3">
            <h2 id="palette-title" className="text-sm font-semibold">
              Add a step
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {PALETTE.map((type) => (
                <Button key={type} size="sm" variant="outline" aria-label={`Add ${STEP_LABELS[type]} step`} onClick={() => add(type)}>
                  {STEP_LABELS[type]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Drag from a way out on the right of a step to another step to connect them.</p>
          </section>
          <TriggerPanel graph={graph} problems={problems} onChange={change} />
          <SecretsPanel flowId={initial.id} secrets={secrets} onChange={setSecrets} />
          <ProblemsPanel problems={problems} onFocusStep={focusStep} />
        </aside>
        <div ref={canvasBox} className="h-[70vh] min-h-[28rem] overflow-hidden rounded-lg border bg-muted/30">
          <FlowCanvas graph={graph} problems={problems} selectedId={selectedId} onSelect={setSelectedId} onChange={change} />
        </div>
        <aside className="content-start rounded-lg border bg-card p-3">
          {selected ? (
            <StepForm
              key={selected.id}
              step={selected}
              graph={graph}
              isStart={graph.start === selected.id}
              problems={problems.filter((p) => p.stepId === selected.id)}
              onChange={change}
              onSetStart={() => change((g) => ({ ...g, start: selected.id }))}
              onDuplicate={() => paste(selected)}
              onDelete={() => deleteStep(selected.id)}
              flowId={initial.id}
              secrets={secrets}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a step on the canvas to edit it, or add one from the left.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
