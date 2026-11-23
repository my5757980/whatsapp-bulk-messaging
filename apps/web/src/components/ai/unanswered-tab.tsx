'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_LIMITS } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type UnansweredQuestion } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

/**
 * Questions the agent could not answer from its knowledge (004 T046, FR-015): most asked first. An
 * answer written here becomes a written answer in the knowledge; dismissing hides the question.
 */
export function UnansweredTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const questions = useQuery({
    queryKey: aiKeys.unansweredList(agentId, status),
    queryFn: () => api<UnansweredQuestion[]>(`/ai-agents/${agentId}/unanswered?status=${status}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: aiKeys.unanswered(agentId) });
    void queryClient.invalidateQueries({ queryKey: aiKeys.knowledge(agentId) });
  };
  const dismiss = useMutation({
    mutationFn: (id: string) => api<void>(`/ai-agents/${agentId}/unanswered/${id}/dismiss`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Question dismissed');
      refresh();
    },
    onError: toastError,
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          When a customer asks something the knowledge does not cover, the question lands here. Answer it once and the agent knows it from then on.
        </p>
        <div className="flex gap-1" role="group" aria-label="Show questions">
          <Button size="sm" variant={status === 'open' ? 'default' : 'outline'} aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            Open
          </Button>
          <Button size="sm" variant={status === 'resolved' ? 'default' : 'outline'} aria-pressed={status === 'resolved'} onClick={() => setStatus('resolved')}>
            Done
          </Button>
        </div>
      </div>
      {questions.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : questions.error ? (
        <p className="text-sm text-destructive">{errorMessage(questions.error)}</p>
      ) : !questions.data?.length ? (
        <p className="text-sm text-muted-foreground">{status === 'open' ? 'No open questions. Nice.' : 'Nothing answered or dismissed yet.'}</p>
      ) : (
        <ul className="grid gap-3" data-testid="unanswered-list">
          {questions.data.map((question) =>
            status === 'open' ? (
              <OpenQuestion
                key={question.id}
                agentId={agentId}
                question={question}
                onAnswered={refresh}
                onDismiss={() => dismiss.mutate(question.id)}
                dismissing={dismiss.isPending && dismiss.variables === question.id}
              />
            ) : (
              <li key={question.id} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{question.text}</p>
                <p className="text-xs text-muted-foreground">
                  Asked {question.askCount === 1 ? 'once' : `${question.askCount} times`} · done {formatDateTime(question.resolvedAt)}
                </p>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

interface OpenQuestionProps {
  agentId: string;
  question: UnansweredQuestion;
  onAnswered: () => void;
  onDismiss: () => void;
  dismissing: boolean;
}

function OpenQuestion({ agentId, question, onAnswered, onDismiss, dismissing }: OpenQuestionProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(question.text.slice(0, AI_LIMITS.questionLength));
  const [answer, setAnswer] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/ai-agents/${agentId}/unanswered/${question.id}/answer`, { method: 'POST', json: { question: text.trim(), answer: answer.trim() } }),
    onSuccess: () => {
      toast.success('Added to the knowledge');
      onAnswered();
    },
    onError: toastError,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && answer.trim()) save.mutate();
  };

  return (
    <li className="grid gap-3 rounded-lg border p-3" data-testid="unanswered-question">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{question.text}</p>
          <p className="text-xs text-muted-foreground">
            Asked {question.askCount === 1 ? 'once' : `${question.askCount} times`} · last {formatDateTime(question.lastAskedAt)}
          </p>
        </div>
        {!open && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setOpen(true)}>
              Add an answer
            </Button>
            <Button size="sm" variant="outline" onClick={onDismiss} disabled={dismissing}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
      {open && (
        <form onSubmit={submit} className="grid gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`uq-question-${question.id}`}>Question</Label>
            <Input id={`uq-question-${question.id}`} value={text} maxLength={AI_LIMITS.questionLength} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`uq-answer-${question.id}`}>Answer</Label>
            <textarea id={`uq-answer-${question.id}`} className={TEXTAREA_CLASS} value={answer} maxLength={AI_LIMITS.answerLength} autoFocus onChange={(e) => setAnswer(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!text.trim() || !answer.trim() || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save answer'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
