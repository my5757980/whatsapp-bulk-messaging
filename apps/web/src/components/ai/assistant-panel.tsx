'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type AssistantActionView, type AssistantDraftLink, type AssistantRequestView } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';

// The team assistant (004 T103, FR-042–FR-046): ask in plain words, get drafts to review, and
// confirm on a preview anything that sends, schedules or deletes.

const PROMPT_MAX = 2000;
const POLL_MS = 2000;

const DRAFT_LINKS: Record<AssistantDraftLink['kind'], { label: string; href: (id: string) => string }> = {
  // Opens the draft in the template editor under its own name; submitting there replaces the draft.
  TEMPLATE: { label: 'Template draft', href: (id) => `/templates/new?from=${id}&draft=1` },
  FLOW: { label: 'Flow draft', href: (id) => `/flows/${id}` },
  CAMPAIGN: { label: 'Campaign draft', href: (id) => `/campaigns/new?id=${id}` },
};

const ERRORS: Record<string, string> = {
  AI_UNAVAILABLE: 'The AI service is not available right now. Try again later.',
  LIMIT_REACHED: 'The monthly assistant limit is reached. An admin can raise it on the AI usage page.',
  REFUSED: 'Your role does not allow what was asked.',
};

/** Header button that opens the assistant (members with `assistant.use`). */
export function AssistantButton() {
  const pathname = usePathname();
  // Open on the page it was opened on: opening a draft goes to its editor, which closes the dialog.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  return (
    <Dialog open={open} onOpenChange={(next) => setOpenOn(next ? pathname : null)}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Assistant
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Assistant</DialogTitle>
          <DialogDescription>
            Ask for a template, a flow or a campaign, or about campaign results. It makes drafts for you to review; anything that sends or deletes waits for your
            confirmation.
          </DialogDescription>
        </DialogHeader>
        {open ? <AssistantPanel /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AssistantPanel() {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const requests = useQuery({
    queryKey: aiKeys.assistant,
    queryFn: () => api<AssistantRequestView[]>('/assistant/requests'),
    // Poll while an answer is on its way.
    refetchInterval: (query) => ((query.state.data ?? []).some((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ? POLL_MS : false),
  });
  const ask = useMutation({
    mutationFn: (text: string) => api<AssistantRequestView>('/assistant/requests', { method: 'POST', json: { prompt: text } }),
    onSuccess: (created) => {
      setPrompt('');
      queryClient.setQueryData<AssistantRequestView[]>(aiKeys.assistant, (list) => [created, ...(list ?? []).filter((r) => r.id !== created.id)]);
    },
    onError: toastError,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim()) ask.mutate(prompt.trim());
  };

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} className="grid gap-2">
        <Label htmlFor="assistant-prompt">Ask the assistant</Label>
        <textarea
          id="assistant-prompt"
          className={TEXTAREA_CLASS}
          maxLength={PROMPT_MAX}
          value={prompt}
          placeholder="For example: write a template for our weekend sale with a Shop now button"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!prompt.trim() || ask.isPending}>
            {ask.isPending ? 'Sending…' : 'Ask'}
          </Button>
        </div>
      </form>

      {requests.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : requests.error ? (
        <p className="text-sm text-destructive">{errorMessage(requests.error)}</p>
      ) : (requests.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing asked yet.</p>
      ) : (
        <ol className="grid gap-3">
          {requests.data!.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </ol>
      )}
    </div>
  );
}

function RequestCard({ request }: { request: AssistantRequestView }) {
  const working = request.status === 'QUEUED' || request.status === 'RUNNING';
  return (
    <li className="grid gap-2 rounded-lg border p-3" data-testid="assistant-request">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{request.prompt}</p>
        <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(request.createdAt)}</span>
      </div>
      {working ? <p className="text-sm text-muted-foreground">Working on it…</p> : null}
      {request.reply ? (
        <p className="whitespace-pre-wrap text-sm" data-testid="assistant-reply">
          {request.reply}
        </p>
      ) : null}
      {request.errorCode && ERRORS[request.errorCode] ? (
        <p className={request.status === 'FAILED' ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>{ERRORS[request.errorCode]}</p>
      ) : null}
      {request.drafts.length ? (
        <ul className="flex flex-wrap gap-2">
          {request.drafts.map((draft) => (
            <li key={`${draft.kind}:${draft.id}`}>
              <Link href={DRAFT_LINKS[draft.kind].href(draft.id)} className="text-sm text-primary underline-offset-2 hover:underline" data-testid="assistant-draft">
                {DRAFT_LINKS[draft.kind].label}: {draft.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {request.actions.map((action) => (
        <ActionPreview key={action.id} action={action} />
      ))}
    </li>
  );
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : '0');
const usd = (value: unknown) => (typeof value === 'number' ? `USD ${value.toFixed(2)}` : 'not known (no rate card)');

/** What the action will do, exactly as the assistant prepared it. */
function PreviewBody({ action }: { action: AssistantActionView }) {
  const p = action.preview;
  if (action.kind === 'SEND_CAMPAIGN' || action.kind === 'SCHEDULE_CAMPAIGN') {
    const campaign = (p.campaign ?? {}) as { name?: string };
    const template = (p.template ?? {}) as { name?: string; language?: string };
    const number = (p.number ?? {}) as { label?: string };
    return (
      <div className="grid gap-1 text-sm">
        <p className="font-medium">
          {action.kind === 'SEND_CAMPAIGN' ? `Send “${text(campaign.name)}” now` : `Schedule “${text(campaign.name)}” for ${formatDateTime(text(p.sendAt))}`}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Template</dt>
          <dd>
            {text(template.name)} ({text(template.language)})
          </dd>
          <dt className="text-muted-foreground">From</dt>
          <dd>{text(number.label)}</dd>
          <dt className="text-muted-foreground">Recipients</dt>
          <dd data-testid="assistant-recipients">{count(p.recipients)}</dd>
          <dt className="text-muted-foreground">Estimated cost</dt>
          <dd>{usd(p.estimatedCostUsd)}</dd>
        </dl>
        {p.warning ? <p className="text-xs text-warning">{text(p.warning)}</p> : null}
      </div>
    );
  }
  if (action.kind === 'DELETE_CONTACTS') {
    const sample = (Array.isArray(p.sample) ? p.sample : []) as Array<{ name: string | null; phone: string | null }>;
    return (
      <div className="grid gap-1 text-sm">
        <p className="font-medium">
          Delete {count(p.count)} contact(s){p.withTag ? ` tagged “${text(p.withTag)}”` : ''}, with their chats and history
        </p>
        <ul className="text-xs text-muted-foreground">
          {sample.map((c, i) => (
            <li key={i}>
              {c.name ?? 'No name'} · {c.phone ?? ''}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const tags = (Array.isArray(p.tags) ? p.tags : []) as Array<{ id: string; name: string; contacts: number }>;
  const notFound = (Array.isArray(p.notFound) ? p.notFound : []) as string[];
  return (
    <div className="grid gap-1 text-sm">
      <p className="font-medium">Delete {tags.length} tag(s); contacts keep everything else</p>
      <ul className="text-xs text-muted-foreground">
        {tags.map((t) => (
          <li key={t.id}>
            {t.name} ({formatNumber(t.contacts)} contacts)
          </li>
        ))}
      </ul>
      {notFound.length ? <p className="text-xs text-muted-foreground">Not found: {notFound.join(', ')}</p> : null}
    </div>
  );
}

const STATUS: Record<AssistantActionView['status'], { label: string; variant: 'success' | 'secondary' | 'destructive' | 'warning' }> = {
  PENDING: { label: 'Waiting for you', variant: 'warning' },
  CONFIRMED: { label: 'Done', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'secondary' },
  EXPIRED: { label: 'Expired: ask again', variant: 'secondary' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

function ActionPreview({ action }: { action: AssistantActionView }) {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: aiKeys.assistant });
  const decide = useMutation({
    mutationFn: (choice: 'confirm' | 'cancel') => api<AssistantActionView>(`/assistant/actions/${action.id}/${choice}`, { method: 'POST' }),
    onSuccess: (updated) => {
      if (updated.status === 'CONFIRMED') toast.success('Done');
      else if (updated.status === 'FAILED') toast.error(text(updated.result?.message) || 'The action failed');
      refresh();
    },
    onError: (error) => {
      toastError(error);
      refresh();
    },
  });
  const status = STATUS[action.status];
  const destructive = action.kind === 'DELETE_CONTACTS' || action.kind === 'DELETE_TAGS';

  return (
    <div className="grid gap-2 rounded-md border bg-muted/40 p-3" data-testid="assistant-action">
      <div className="flex items-start justify-between gap-3">
        <PreviewBody action={action} />
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      {action.status === 'FAILED' && action.result?.message ? <p className="text-xs text-destructive">{text(action.result.message)}</p> : null}
      {action.status === 'PENDING' ? (
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">Confirm before {formatDateTime(action.expiresAt)}</span>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate('cancel')}>
            Cancel
          </Button>
          <Button size="sm" variant={destructive ? 'destructive' : 'default'} disabled={decide.isPending} onClick={() => decide.mutate('confirm')}>
            {decide.isPending ? 'Working…' : 'Confirm'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
