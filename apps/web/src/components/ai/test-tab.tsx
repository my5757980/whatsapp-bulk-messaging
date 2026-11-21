'use client';

import { useMutation } from '@tanstack/react-query';
import { AI_LIMITS } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import type { AgentDetail, PreviewMessage, PreviewResult } from '@/lib/ai';
import { api, ApiError } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';

const SOURCE_KINDS: Record<string, string> = { ANSWER: 'Written answer', WEBSITE: 'Website', FILE: 'File' };

interface Turn extends PreviewMessage {
  result?: PreviewResult;
}

interface TestTabProps {
  agentId: string;
  testNumbers: string[];
  /** Saves the editor's pending changes, so the preview runs the newest draft; false when it could not. */
  prepare: () => Promise<boolean>;
}

/**
 * Try the draft before customers meet it (004 T063, FR-034, FR-035): a preview chat that sends nothing
 * on WhatsApp and shows the knowledge used and what the reply would do, and the up to 3 test phones
 * that meet the draft in real chats.
 */
export function TestTab({ agentId, testNumbers, prepare }: TestTabProps) {
  return (
    <div className="grid gap-8">
      <PreviewChat agentId={agentId} prepare={prepare} />
      <TestNumbers agentId={agentId} initial={testNumbers} />
    </div>
  );
}

function PreviewChat({ agentId, prepare }: { agentId: string; prepare: () => Promise<boolean> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [contactName, setContactName] = useState('');
  const ask = useMutation({
    mutationFn: async (conversation: Turn[]) => {
      if (!(await prepare())) throw new Error('UNSAVED');
      const messages = conversation.map(({ from, text: t }) => ({ from, text: t }));
      return api<PreviewResult>(`/ai-agents/${agentId}/preview`, {
        method: 'POST',
        json: { messages, ...(contactName.trim() ? { contact: { name: contactName.trim() } } : {}) },
      });
    },
    onSuccess: (result) => setTurns((current) => [...current, { from: 'agent', text: result.reply.message, result }]),
    onError: (error) => {
      // The customer's message stays, so the member can try again.
      if (error instanceof Error && error.message === 'UNSAVED') toast.error('The draft could not be saved, so the preview did not run');
      else if (error instanceof ApiError && error.code === 'PREVIEW_RATE_LIMITED') toast.error(error.message);
      else toastError(error);
    },
  });

  const send = (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || ask.isPending) return;
    const next: Turn[] = [...turns, { from: 'customer', text: message }];
    setTurns(next);
    setText('');
    ask.mutate(next);
  };
  const retry = () => {
    if (turns.at(-1)?.from === 'customer') ask.mutate(turns);
  };

  return (
    <section className="grid gap-3" aria-labelledby="preview-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="preview-title" className="text-base font-semibold">
            Preview
          </h2>
          <p className="text-sm text-muted-foreground">Write as a customer. The draft answers here only; nothing is sent on WhatsApp and no contact changes.</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="preview-contact">Customer name (optional)</Label>
            <Input id="preview-contact" className="h-8 w-48" value={contactName} maxLength={120} onChange={(e) => setContactName(e.target.value)} />
          </div>
          <Button size="sm" variant="outline" onClick={() => setTurns([])} disabled={!turns.length || ask.isPending}>
            Start over
          </Button>
        </div>
      </div>
      <div className="grid max-h-[28rem] min-h-40 content-start gap-3 overflow-y-auto rounded-lg border bg-muted/30 p-3" data-testid="preview-chat">
        {turns.length === 0 && <p className="text-sm text-muted-foreground">Ask something a customer would ask, for example about prices or delivery.</p>}
        {turns.map((turn, i) =>
          turn.from === 'customer' ? (
            <div key={i} className="flex justify-start">
              <p className="max-w-[78%] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm shadow-sm">{turn.text}</p>
            </div>
          ) : (
            <div key={i} className="flex justify-end">
              <div className="grid max-w-[78%] gap-2 rounded-lg bg-emerald-50 px-3 py-2 shadow-sm dark:bg-emerald-950" data-testid="preview-reply">
                {turn.text ? <p className="whitespace-pre-wrap text-sm">{turn.text}</p> : <p className="text-sm italic text-muted-foreground">No message would be sent.</p>}
                {turn.result?.reply.buttons?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {turn.result.reply.buttons.map((b) => (
                      <Badge key={b} variant="outline">
                        {b}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {turn.result && <PreviewDetails result={turn.result} />}
              </div>
            </div>
          ),
        )}
        {ask.isPending && <p className="text-right text-xs text-muted-foreground">The draft is writing…</p>}
        {ask.isError && turns.at(-1)?.from === 'customer' && (
          <div className="flex justify-end gap-2 text-xs text-destructive">
            <span>{errorMessage(ask.error)}</span>
            <button type="button" className="underline" onClick={retry}>
              Try again
            </button>
          </div>
        )}
      </div>
      <form onSubmit={send} className="flex gap-2">
        <Input aria-label="Message as the customer" placeholder="Message as the customer" value={text} maxLength={4096} onChange={(e) => setText(e.target.value)} disabled={ask.isPending} />
        <Button type="submit" disabled={!text.trim() || ask.isPending}>
          Send
        </Button>
      </form>
    </section>
  );
}

function PreviewDetails({ result }: { result: PreviewResult }) {
  const seconds = result.usage.durationMs !== undefined ? `${(result.usage.durationMs / 1000).toFixed(1)} s` : null;
  const cost = result.usage.costUsd !== undefined ? `$${result.usage.costUsd.toFixed(4)}` : null;
  return (
    <div className="grid gap-1 border-t border-emerald-200 pt-2 text-xs text-muted-foreground dark:border-emerald-800">
      {result.sources.length > 0 && (
        <div data-testid="preview-sources">
          <span className="font-medium">Used:</span>{' '}
          {result.sources.map((s) => `${SOURCE_KINDS[s.kind] ?? s.kind}: ${s.title}`).join('; ')}
        </div>
      )}
      {result.wouldDo.length > 0 && (
        <ul className="grid gap-0.5" data-testid="preview-would-do">
          {result.wouldDo.map((item, i) => (
            <li key={i} className="text-amber-700 dark:text-amber-300">
              {item.description}
            </li>
          ))}
        </ul>
      )}
      {(seconds || cost) && <div>{[seconds, cost].filter(Boolean).join(' · ')}</div>}
    </div>
  );
}

function TestNumbers({ agentId, initial }: { agentId: string; initial: string[] }) {
  const [saved, setSaved] = useState<string[]>(initial);
  const [values, setValues] = useState<string[]>(() => [...initial, '', '', ''].slice(0, AI_LIMITS.testNumbers));
  const save = useMutation({
    mutationFn: () => api<AgentDetail>(`/ai-agents/${agentId}/test-numbers`, { method: 'PUT', json: { testNumbers: values.map((v) => v.trim()).filter(Boolean) } }),
    onSuccess: (agent) => {
      setSaved(agent.testNumbers);
      setValues([...agent.testNumbers, '', '', ''].slice(0, AI_LIMITS.testNumbers));
      toast.success('Test numbers saved');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details?.length) toast.error(error.details.map((d) => d.issue).join('; '));
      else toastError(error);
    },
  });

  return (
    <section className="grid gap-3" aria-labelledby="test-numbers-title">
      <div>
        <h2 id="test-numbers-title" className="text-base font-semibold">
          Test numbers
        </h2>
        <p className="text-sm text-muted-foreground">
          Up to {AI_LIMITS.testNumbers} phones that meet the draft in real WhatsApp chats while everyone else meets the published version. Their replies are marked test.
        </p>
      </div>
      <form
        className="grid max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {values.map((value, i) => (
          <Input
            key={i}
            aria-label={`Test number ${i + 1}`}
            placeholder="+971 50 123 4567"
            value={value}
            maxLength={20}
            onChange={(e) => setValues((current) => current.map((v, j) => (j === i ? e.target.value : v)))}
          />
        ))}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save test numbers'}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="saved-test-numbers">
            {saved.length ? `Saved: ${saved.join(', ')}` : 'No test numbers yet'}
          </span>
        </div>
      </form>
    </section>
  );
}
