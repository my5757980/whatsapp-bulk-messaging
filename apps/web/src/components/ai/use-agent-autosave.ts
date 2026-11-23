import { AgentConfigSchema, type AgentConfig, type AgentProblem } from '@wbm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'invalid' | 'error' | 'conflict';
export const AUTOSAVE_DELAY_MS = 1000;

interface AutosaveOptions {
  agentId: string;
  config: AgentConfig;
  initialConfig: AgentConfig;
  initialRevision: number;
  onSaved: (problems: AgentProblem[]) => void;
  onConflict: () => void;
}

/**
 * Saves the agent's draft 1 s after the last change, like the 003 flow editor: one save at a time,
 * each with the revision the previous one returned; a 409 DRAFT_CONFLICT stops saving and asks for a
 * reload. A configuration the server would refuse is not sent (the status says why).
 */
export function useAgentAutosave({ agentId, config, initialConfig, initialRevision, onSaved, onConflict }: AutosaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [detail, setDetail] = useState<string | null>(null);
  const revision = useRef(initialRevision);
  const saved = useRef(initialConfig);
  const latest = useRef(config);
  const running = useRef<Promise<boolean> | null>(null);
  const stopped = useRef(false);
  const callbacks = useRef({ onSaved, onConflict });

  useEffect(() => {
    callbacks.current = { onSaved, onConflict };
  });

  /** Saves the newest configuration now (after any save in progress); true when the server has it. */
  const flush = useCallback(async (): Promise<boolean> => {
    while (running.current) await running.current;
    if (stopped.current) return false;
    const snapshot = latest.current;
    if (snapshot === saved.current) return true;
    const parsed = AgentConfigSchema.safeParse(snapshot);
    if (!parsed.success) {
      setStatus('invalid');
      setDetail(parsed.error.issues[0] ? `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}` : 'A value cannot be saved');
      return false;
    }
    const work = (async () => {
      setStatus('saving');
      try {
        const result = await api<{ draftRevision: number; problems: AgentProblem[] }>(`/ai-agents/${agentId}/draft`, {
          method: 'PUT',
          json: { config: snapshot, draftRevision: revision.current },
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
  }, [agentId]);

  useEffect(() => {
    latest.current = config;
    if (config === saved.current || stopped.current) return;
    setStatus('pending');
    const timer = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [config, flush]);

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
