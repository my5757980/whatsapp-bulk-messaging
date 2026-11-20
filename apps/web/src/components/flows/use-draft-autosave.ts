import { FlowGraphSchema, type FlowGraph, type Problem } from '@wbm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'invalid' | 'error' | 'conflict';
export const AUTOSAVE_DELAY_MS = 1000;

interface AutosaveOptions {
  flowId: string;
  graph: FlowGraph;
  initialGraph: FlowGraph;
  initialRevision: number;
  onSaved: (problems: Problem[]) => void;
  onConflict: () => void;
}

/**
 * Saves the draft 1 s after the last change (FR-005). Saves run one at a time, each sending the
 * revision the previous one returned; a 409 DRAFT_CONFLICT stops saving and asks for a reload.
 * A graph the server would refuse is not sent (the status says why).
 */
export function useDraftAutosave({ flowId, graph, initialGraph, initialRevision, onSaved, onConflict }: AutosaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [detail, setDetail] = useState<string | null>(null);
  const revision = useRef(initialRevision);
  const saved = useRef(initialGraph);
  const latest = useRef(graph);
  const running = useRef<Promise<boolean> | null>(null);
  const stopped = useRef(false);
  const callbacks = useRef({ onSaved, onConflict });

  useEffect(() => {
    callbacks.current = { onSaved, onConflict };
  });

  /** Saves the newest graph now (after any save in progress); true when the server has it. */
  const flush = useCallback(async (): Promise<boolean> => {
    while (running.current) await running.current;
    if (stopped.current) return false;
    const snapshot = latest.current;
    if (snapshot === saved.current) return true;
    const parsed = FlowGraphSchema.safeParse(snapshot);
    if (!parsed.success) {
      setStatus('invalid');
      setDetail(parsed.error.issues[0]?.message ?? 'The flow has a value that cannot be saved');
      return false;
    }
    const work = (async () => {
      setStatus('saving');
      try {
        const result = await api<{ draftRevision: number; problems: Problem[] }>(`/flows/${flowId}/draft`, {
          method: 'PUT',
          json: { graph: snapshot, draftRevision: revision.current },
        });
        revision.current = result.draftRevision;
        saved.current = snapshot;
        callbacks.current.onSaved(result.problems);
        setStatus(latest.current === snapshot ? 'saved' : 'pending');
        setDetail(null);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'DRAFT_CONFLICT') {
          stopped.current = true;
          setStatus('conflict');
          callbacks.current.onConflict();
        } else {
          setStatus('error');
          setDetail(errorMessage(error));
        }
        return false;
      } finally {
        running.current = null;
      }
    })();
    running.current = work;
    return work;
  }, [flowId]);

  useEffect(() => {
    latest.current = graph;
    if (graph === saved.current || stopped.current) return;
    setStatus('pending');
    const timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [graph, flush]);

  // Leaving the editor saves what is left; closing the tab first asks while something is unsaved.
  useEffect(() => () => void flush(), [flush]);
  useEffect(() => {
    if (status === 'saved' || status === 'conflict') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  return { status, detail, flush };
}
