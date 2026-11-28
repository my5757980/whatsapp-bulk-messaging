'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, useRef } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { savedRepliesKey } from '@/components/inbox/saved-reply-picker';
import { mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { Can } from '@/lib/permissions';
import { InsertGlobalAttribute, insertAtCursor } from '@/components/settings/insert-global-attribute';
import { globalPlaceholder } from '@/lib/global-attributes';

interface SavedReply {
  id: string;
  name: string;
  type: 'TEXT' | 'MEDIA';
  text?: string;
  variableFallbacks: Record<string, string>;
  mediaAssetId?: string;
  mediaUrl?: string;
  fileName?: string;
  parameterCount: number;
  createdBy: { id: string; name: string } | null;
}

const VARIABLES = ['{first_name}', '{last_name}', '{name}', '{phone}', '{attr:city}', '{global:name}', '{{1}}'];

/** Settings > Saved replies (T066, FR-030): admins and managers create, edit and delete; everyone uses them in chats. */
export default function SavedRepliesPage() {
  return (
    <RequirePermission permission="inbox.view">
      <SavedReplies />
    </RequirePermission>
  );
}

function SavedReplies() {
  const queryClient = useQueryClient();
  const replies = useQuery({ queryKey: savedRepliesKey, queryFn: () => api<SavedReply[]>('/canned-messages') });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/canned-messages/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: savedRepliesKey }),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not delete'),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Saved replies</CardTitle>
          <CardDescription>Ready answers for live chat. Members type &quot;/&quot; in the reply box to use them. Up to 200.</CardDescription>
        </div>
        <Can permission="canned.manage">
          <ReplyEditor />
        </Can>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2" data-testid="saved-replies">
          {replies.data?.length === 0 && <li className="text-sm text-muted-foreground">No saved replies yet.</li>}
          {replies.data?.map((reply) => (
            <li key={reply.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{reply.name}</p>
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{reply.type === 'MEDIA' ? `📎 ${reply.fileName ?? 'File'}${reply.text ? ` — ${reply.text}` : ''}` : reply.text}</p>
              </div>
              <Can permission="canned.manage">
                <div className="flex shrink-0 gap-1">
                  <ReplyEditor reply={reply} />
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="sm" className="text-destructive">
                        Delete
                      </Button>
                    }
                    title={`Delete "${reply.name}"?`}
                    description="Members will no longer find it. Messages already sent stay as they are."
                    confirmLabel="Delete"
                    confirmVariant="destructive"
                    onConfirm={() => remove.mutateAsync(reply.id)}
                  />
                </div>
              </Can>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ReplyEditor({ reply }: { reply?: SavedReply }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'TEXT' | 'MEDIA'>(reply?.type ?? 'TEXT');
  const [mediaAssetId, setMediaAssetId] = useState(reply?.mediaAssetId ?? '');
  const textBox = useRef<HTMLTextAreaElement>(null);
  const media = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'), enabled: open && type === 'MEDIA' });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<SavedReply>(reply ? `/canned-messages/${reply.id}` : '/canned-messages', { method: reply ? 'PATCH' : 'POST', json: body }),
    onSuccess: () => {
      toast.success('Saved reply stored');
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: savedRepliesKey });
    },
    onError: (error) => toast.error(error instanceof ApiError ? (error.details?.[0] ? `${error.details[0].field} ${error.details[0].issue}` : error.message) : 'Could not save'),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fallbacks: Record<string, string> = {};
    for (const line of String(form.get('fallbacks') ?? '').split('\n')) {
      const [key, ...value] = line.split('=');
      if (key?.trim() && value.join('=').trim()) fallbacks[key.trim()] = value.join('=').trim();
    }
    const text = String(form.get('text') ?? '');
    save.mutate({
      name: String(form.get('name') ?? '').trim(),
      type,
      ...(text.trim() ? { text } : {}),
      variableFallbacks: fallbacks,
      ...(type === 'MEDIA' ? (mediaAssetId ? { mediaAssetId } : { mediaUrl: String(form.get('mediaUrl') ?? '').trim() }) : {}),
      ...(type === 'MEDIA' && String(form.get('fileName') ?? '').trim() ? { fileName: String(form.get('fileName')).trim() } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={reply ? 'ghost' : 'default'} size="sm">
          {reply ? 'Edit' : 'New saved reply'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-3">
          <DialogHeader>
            <DialogTitle>{reply ? 'Edit saved reply' : 'New saved reply'}</DialogTitle>
            <DialogDescription>Variables: {VARIABLES.join(' ')} — WhatsApp formatting like *bold* is kept.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="reply-name">Name</Label>
            <Input id="reply-name" name="name" defaultValue={reply?.name} maxLength={80} required />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="reply-type">Type</Label>
            <NativeSelect id="reply-type" value={type} onChange={(e) => setType(e.target.value as 'TEXT' | 'MEDIA')}>
              <option value="TEXT">Text</option>
              <option value="MEDIA">File with optional text</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="reply-text">{type === 'MEDIA' ? 'Caption (optional)' : 'Text'}</Label>
              {/* Feature 010 (US3): the placeholder, so the value is read when the reply is sent. */}
              <InsertGlobalAttribute
                onInsert={(g) => {
                  const box = textBox.current;
                  if (box) box.value = insertAtCursor(box, box.value, globalPlaceholder(g.key)).slice(0, 4096);
                }}
              />
            </div>
            <textarea ref={textBox} id="reply-text" name="text" defaultValue={reply?.text} maxLength={4096} className="min-h-[96px] rounded-md border bg-background px-3 py-2 text-sm" />
          </div>
          {type === 'MEDIA' && (
            <>
              <div className="grid gap-1">
                <Label htmlFor="reply-media">File from the media library</Label>
                <NativeSelect id="reply-media" value={mediaAssetId} onChange={(e) => setMediaAssetId(e.target.value)}>
                  <option value="">Use a public link instead</option>
                  {media.data?.items.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {!mediaAssetId && (
                <div className="grid gap-1">
                  <Label htmlFor="reply-url">Public https link</Label>
                  <Input id="reply-url" name="mediaUrl" type="url" defaultValue={reply?.mediaUrl} placeholder="https://…" />
                </div>
              )}
              <div className="grid gap-1">
                <Label htmlFor="reply-file-name">File name for documents (optional)</Label>
                <Input id="reply-file-name" name="fileName" defaultValue={reply?.fileName} maxLength={240} />
              </div>
            </>
          )}
          <div className="grid gap-1">
            <Label htmlFor="reply-fallbacks">Fallbacks, one per line (e.g. first_name=there)</Label>
            <textarea
              id="reply-fallbacks"
              name="fallbacks"
              defaultValue={Object.entries(reply?.variableFallbacks ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')}
              className="min-h-[56px] rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
