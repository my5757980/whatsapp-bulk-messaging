'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AgentDetail } from '@/lib/ai';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import type { WhatsAppNumber } from '@/lib/types';
import { toast } from '@/components/ui/toaster';

interface NumbersPanelProps {
  agent: Pick<AgentDetail, 'id' | 'numbers' | 'status'>;
  onChanged: (agent: AgentDetail) => void;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The WhatsApp numbers the agent answers on (004 T045, FR-004). A number has at most one agent;
 * taking one from another agent asks first.
 */
export function NumbersPanel({ agent, onChanged }: NumbersPanelProps) {
  const numbers = useQuery({ queryKey: queryKeys.numbers, queryFn: () => api<WhatsAppNumber[]>('/numbers') });
  const current = agent.numbers.map((n) => n.id);
  const [selected, setSelected] = useState<string[]>(current);
  const [taken, setTaken] = useState<string[] | null>(null);

  const save = useMutation({
    mutationFn: (replace: boolean) => api<AgentDetail>(`/ai-agents/${agent.id}/numbers`, { method: 'PUT', json: { numberIds: selected, replace } }),
    onSuccess: (next) => {
      setTaken(null);
      setSelected(next.numbers.map((n) => n.id));
      onChanged(next);
      toast.success('Numbers saved');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'NUMBER_HAS_AGENT') setTaken((error.details ?? []).map((d) => d.issue));
      else toastError(error);
    },
  });

  return (
    <section aria-labelledby="numbers-title" className="grid gap-2 rounded-lg border bg-card p-3">
      <h2 id="numbers-title" className="text-sm font-semibold">
        Answers on
      </h2>
      {numbers.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : numbers.error ? (
        <p className="text-sm text-destructive">{errorMessage(numbers.error)}</p>
      ) : !numbers.data?.length ? (
        <p className="text-sm text-muted-foreground">No WhatsApp numbers connected yet.</p>
      ) : (
        <ul className="grid gap-1">
          {numbers.data.map((number) => (
            <li key={number.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(number.id)}
                  onChange={(e) => {
                    setTaken(null);
                    setSelected((ids) => (e.target.checked ? [...ids, number.id] : ids.filter((id) => id !== number.id)));
                  }}
                />
                <span>{number.displayPhoneNumber}</span>
                {number.label && <span className="text-xs text-muted-foreground">{number.label}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {agent.status !== 'PUBLISHED' && <p className="text-xs text-muted-foreground">Customers meet the agent once it is published.</p>}
      {taken ? (
        <div className="grid gap-2 rounded-md border border-warning p-2" role="alert">
          <ul className="grid gap-0.5 text-xs">
            {taken.map((issue) => (
              <li key={issue}>{issue}.</li>
            ))}
          </ul>
          <p className="text-xs">Move these numbers to this agent? The other agent stops answering on them.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate(true)} disabled={save.isPending}>
              Move numbers
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTaken(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending || sameIds(selected, current)}>
          {save.isPending ? 'Saving…' : 'Save numbers'}
        </Button>
      )}
    </section>
  );
}
