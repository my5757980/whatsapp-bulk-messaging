'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_LIMITS } from '@wbm/shared';
import { useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { aiKeys, type KnowledgeList, type KnowledgeSource } from '@/lib/ai';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';

const KIND_LABEL: Record<KnowledgeSource['kind'], string> = { ANSWER: 'Written answer', WEBSITE: 'Website', FILE: 'File' };
const FILE_TYPES = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const POLL_MS = 3000;

function StatusBadge({ source }: { source: KnowledgeSource }) {
  if (source.status === 'PROCESSING') return <Badge variant="secondary">Reading…</Badge>;
  if (source.status === 'FAILED') return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="success">Ready</Badge>;
}

function sizeOf(source: KnowledgeSource): string {
  const parts = [`${formatNumber(source.charCount)} characters`];
  if (source.kind === 'WEBSITE' && source.pagesRead != null) parts.push(`${source.pagesRead} pages`);
  if (source.kind === 'FILE' && source.sizeBytes != null) parts.push(`${(source.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
}

/**
 * What the agent answers from (004 T045, FR-010–FR-015): written answers, websites and PDF or Word
 * files, read in the background. Knowledge is live: changes reach customers without publishing.
 */
export function KnowledgeTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const key = aiKeys.knowledge(agentId);
  const knowledge = useQuery({
    queryKey: key,
    queryFn: () => api<KnowledgeList>(`/ai-agents/${agentId}/knowledge`),
    // Websites and files are read in the background: look again until they are done.
    refetchInterval: (query) => (query.state.data?.sources.some((s) => s.status === 'PROCESSING') ? POLL_MS : false),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) => api<KnowledgeSource>(`/ai-agents/${agentId}/knowledge/${id}`, { method: 'PATCH', json: body }),
    onSuccess: () => refresh(),
    onError: toastError,
  });
  const reread = useMutation({
    mutationFn: (id: string) => api<KnowledgeSource>(`/ai-agents/${agentId}/knowledge/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Reading it again');
      refresh();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/ai-agents/${agentId}/knowledge/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Removed from the knowledge');
      refresh();
    },
    onError: toastError,
  });

  if (knowledge.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (knowledge.error || !knowledge.data) return <p className="text-sm text-destructive">{errorMessage(knowledge.error)}</p>;
  const { sources, totalChars, mode, limits } = knowledge.data;
  const count = (kind: KnowledgeSource['kind']) => sources.filter((s) => s.kind === kind).length;

  return (
    <div className="grid gap-6">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm" data-testid="knowledge-summary">
        <p>
          <span className="font-medium">{formatNumber(totalChars)} characters</span> of knowledge switched on.{' '}
          {mode === 'WHOLE'
            ? 'The agent reads all of it for every reply.'
            : 'That is more than fits in one reply, so the agent keeps your written answers at hand and searches the rest for each question.'}
        </p>
        <p className="text-muted-foreground">Changes here reach customers at once; you do not need to publish again.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <AddAnswer agentId={agentId} used={count('ANSWER')} limit={limits.answers} onAdded={refresh} />
        <AddWebsite agentId={agentId} used={count('WEBSITE')} limit={limits.websites} onAdded={refresh} />
        <AddFile agentId={agentId} used={count('FILE')} limit={limits.files} onAdded={refresh} />
      </div>

      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No knowledge yet. Add written answers, a website or files above.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>On</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <TableRow key={source.id} data-testid="knowledge-row">
                <TableCell className="max-w-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{source.kind === 'ANSWER' ? source.question : source.title}</span>
                    {source.replaceMe && <Badge variant="warning">Replace me</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {KIND_LABEL[source.kind]}
                    {source.kind === 'WEBSITE' && source.url ? ` · ${source.url}` : ''}
                    {source.kind === 'FILE' && source.fileName && source.fileName !== source.title ? ` · ${source.fileName}` : ''}
                    {` · ${sizeOf(source)}`}
                    {source.kind === 'WEBSITE' && source.refreshWeekly ? ' · read again every week' : ''}
                    {source.lastRefreshedAt ? ` · read ${formatDateTime(source.lastRefreshedAt)}` : ''}
                  </div>
                  {source.kind === 'ANSWER' && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{source.answer}</p>}
                </TableCell>
                <TableCell>
                  <StatusBadge source={source} />
                  {source.status === 'FAILED' && source.errorMessage && <div className="mt-1 max-w-xs text-xs text-destructive">{source.errorMessage}</div>}
                </TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={`Use ${source.kind === 'ANSWER' ? source.question : source.title}`}
                    checked={source.enabled}
                    disabled={update.isPending}
                    onChange={(e) => update.mutate({ id: source.id, body: { enabled: e.target.checked } })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    {source.kind === 'ANSWER' ? (
                      <Button size="sm" variant="outline" onClick={() => setEditing(source)}>
                        Edit
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={source.status === 'PROCESSING' || reread.isPending} onClick={() => reread.mutate(source.id)}>
                        Refresh
                      </Button>
                    )}
                    <ConfirmDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Delete
                        </Button>
                      }
                      title="Remove this from the knowledge?"
                      description="The agent stops using it at once. Uploaded files are deleted."
                      confirmLabel="Remove"
                      confirmVariant="destructive"
                      onConfirm={() => remove.mutateAsync(source.id).catch(() => undefined)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editing && (
        <EditAnswerDialog
          source={editing}
          onClose={() => setEditing(null)}
          onSave={(body) => update.mutateAsync({ id: editing.id, body }).then(() => setEditing(null))}
        />
      )}
    </div>
  );
}

function AddAnswer({ agentId, used, limit, onAdded }: { agentId: string; used: number; limit: number; onAdded: () => void }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const add = useMutation({
    mutationFn: () => api<KnowledgeSource>(`/ai-agents/${agentId}/knowledge/answers`, { method: 'POST', json: { question: question.trim(), answer: answer.trim() } }),
    onSuccess: () => {
      setQuestion('');
      setAnswer('');
      toast.success('Answer added');
      onAdded();
    },
    onError: toastError,
  });
  const full = used >= limit;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (question.trim() && answer.trim() && !full) add.mutate();
  };

  return (
    <form onSubmit={submit} className="grid content-start gap-2 rounded-lg border p-3" aria-labelledby="add-answer-title">
      <h3 id="add-answer-title" className="text-sm font-semibold">
        Written answer <span className="font-normal text-muted-foreground">({used}/{limit})</span>
      </h3>
      <div className="grid gap-1">
        <Label htmlFor="kn-question">Question</Label>
        <Input id="kn-question" value={question} maxLength={AI_LIMITS.questionLength} placeholder="How much is delivery to Sharjah?" onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="kn-answer">Answer</Label>
        <textarea id="kn-answer" className={TEXTAREA_CLASS} value={answer} maxLength={AI_LIMITS.answerLength} placeholder="Delivery to Sharjah costs AED 50." onChange={(e) => setAnswer(e.target.value)} />
      </div>
      <Button type="submit" size="sm" disabled={!question.trim() || !answer.trim() || full || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add answer'}
      </Button>
    </form>
  );
}

function AddWebsite({ agentId, used, limit, onAdded }: { agentId: string; used: number; limit: number; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [refreshWeekly, setRefreshWeekly] = useState(false);
  const add = useMutation({
    mutationFn: () => api<KnowledgeSource>(`/ai-agents/${agentId}/knowledge/websites`, { method: 'POST', json: { url: url.trim(), refreshWeekly } }),
    onSuccess: () => {
      setUrl('');
      setRefreshWeekly(false);
      toast.success('Reading the website. This can take a few minutes.');
      onAdded();
    },
    onError: toastError,
  });
  const full = used >= limit;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() && !full) add.mutate();
  };

  return (
    <form onSubmit={submit} className="grid content-start gap-2 rounded-lg border p-3" aria-labelledby="add-website-title">
      <h3 id="add-website-title" className="text-sm font-semibold">
        Website <span className="font-normal text-muted-foreground">({used}/{limit})</span>
      </h3>
      <div className="grid gap-1">
        <Label htmlFor="kn-url">Address</Label>
        <Input id="kn-url" type="url" value={url} placeholder="https://www.example.com/help" onChange={(e) => setUrl(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={refreshWeekly} onChange={(e) => setRefreshWeekly(e.target.checked)} />
        Read it again every week
      </label>
      <p className="text-xs text-muted-foreground">
        We read up to {AI_LIMITS.pagesPerSite} pages under this address on the same site and respect its robots.txt.
      </p>
      <Button type="submit" size="sm" disabled={!url.trim() || full || add.isPending}>
        {add.isPending ? 'Adding…' : 'Add website'}
      </Button>
    </form>
  );
}

function AddFile({ agentId, used, limit, onAdded }: { agentId: string; used: number; limit: number; onAdded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api<KnowledgeSource>(`/ai-agents/${agentId}/knowledge/files`, { method: 'POST', body });
    },
    onSuccess: (source) => {
      toast.success(`Reading "${source.title}"`);
      onAdded();
    },
    onError: toastError,
    onSettled: () => {
      if (input.current) input.current.value = '';
    },
  });
  const full = used >= limit;

  return (
    <div className="grid content-start gap-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">
        File <span className="font-normal text-muted-foreground">({used}/{limit})</span>
      </h3>
      <Label htmlFor="kn-file">PDF or Word (.docx)</Label>
      <input
        id="kn-file"
        ref={input}
        type="file"
        accept={FILE_TYPES}
        className="text-sm"
        disabled={full || upload.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > AI_LIMITS.fileBytes) {
            toast.error('The file is larger than 20 MB');
            e.target.value = '';
            return;
          }
          upload.mutate(file);
        }}
      />
      <p className="text-xs text-muted-foreground">
        Up to 20 MB and {AI_LIMITS.filePages} pages. Scanned pages without text cannot be read.
      </p>
      {upload.isPending && <p className="text-xs text-muted-foreground">Uploading…</p>}
    </div>
  );
}

function EditAnswerDialog({ source, onClose, onSave }: { source: KnowledgeSource; onClose: () => void; onSave: (body: { question: string; answer: string }) => Promise<unknown> }) {
  const [question, setQuestion] = useState(source.question ?? '');
  const [answer, setAnswer] = useState(source.answer ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || !answer.trim()) return;
    setBusy(true);
    try {
      await onSave({ question: question.trim(), answer: answer.trim() });
    } catch {
      // The mutation already showed the error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>Edit written answer</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="edit-question">Question</Label>
            <Input id="edit-question" value={question} maxLength={AI_LIMITS.questionLength} onChange={(e) => setQuestion(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="edit-answer">Answer</Label>
            <textarea id="edit-answer" className={TEXTAREA_CLASS} value={answer} maxLength={AI_LIMITS.answerLength} onChange={(e) => setAnswer(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!question.trim() || !answer.trim() || busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
