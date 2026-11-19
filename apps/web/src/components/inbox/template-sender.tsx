'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ChatItem, ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import type { Template } from '@/lib/types';

/** Body text with the typed values filled in, for the preview. */
function preview(template: Template, params: Record<string, string>): string {
  const body = template.components.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? '';
  return body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => params[`BODY.${key}`]?.trim() || match);
}

/**
 * Sends an approved template from a chat (T044, FR-008, FR-016, FR-017). Works in Past chats,
 * where a template is the only way to restart the conversation.
 */
export function TemplateSender({ chat, variant = 'default' }: { chat: ConversationDetail; variant?: 'default' | 'outline' }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});

  const templates = useQuery({
    queryKey: ['templates', { status: 'APPROVED', numberId: chat.numberId }],
    queryFn: () => api<Template[]>(`/templates?status=APPROVED&numberId=${chat.numberId}`),
    enabled: open,
  });
  const template = templates.data?.find((t) => t.id === templateId);
  const mediaHeader = template?.components.find((c) => c.type.toUpperCase() === 'HEADER' && c.format && c.format.toUpperCase() !== 'TEXT');
  const missing = template ? template.variables.filter((v) => !params[v.key]?.trim()).length : 0;

  const send = useMutation({
    mutationFn: () => {
      const values = Object.fromEntries((template?.variables ?? []).map((v) => [v.key, params[v.key]?.trim() ?? '']));
      return api<ChatItem>(`/inbox/conversations/${chat.id}/template`, { method: 'POST', json: { templateId, params: values } });
    },
    onSuccess: () => {
      toast.success('Template queued');
      setOpen(false);
      setTemplateId('');
      setParams({});
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(chat.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(chat.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The template could not be sent'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>
          Send template
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>Approved templates of {chat.numberLabel}. A template can start the conversation again at any time.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="chat-template">Template</Label>
            <NativeSelect
              id="chat-template"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setParams({});
              }}
            >
              <option value="">{templates.isLoading ? 'Loading…' : 'Choose a template'}</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language}, {t.category.toLowerCase()})
                </option>
              ))}
            </NativeSelect>
          </div>
          {template?.variables.map((v) => (
            <div key={v.key} className="grid gap-1">
              <Label htmlFor={`chat-var-${v.key}`}>{v.key}</Label>
              <Input id={`chat-var-${v.key}`} value={params[v.key] ?? ''} placeholder={v.example} maxLength={1024} onChange={(e) => setParams({ ...params, [v.key]: e.target.value })} />
            </div>
          ))}
          {mediaHeader && (
            <p className="text-sm text-destructive">This template needs a {mediaHeader.format?.toLowerCase()} header file; choosing files arrives with the media library.</p>
          )}
          {template && (
            <div className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm" aria-label="Template preview">
              {preview(template, params)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => send.mutate()} disabled={!template || missing > 0 || Boolean(mediaHeader) || send.isPending}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
