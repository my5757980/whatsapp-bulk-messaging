'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { mediaLibraryKey, uploadToLibrary, type MediaItem } from '@/components/inbox/media-picker';
import { RequirePermission } from '@/components/require-permission';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Can } from '@/lib/permissions';

const ICON = { image: '🖼️', video: '🎥', audio: '🎵', document: '📄' } as const;

/** Settings > Media library (T066, FR-032): files reused in chats and saved replies. */
export default function MediaLibraryPage() {
  return (
    <RequirePermission permission="inbox.view">
      <Library />
    </RequirePermission>
  );
}

function Library() {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const items = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: mediaLibraryKey });

  const upload = useMutation({
    mutationFn: (file: File) => uploadToLibrary(file, displayName.trim() || undefined),
    onSuccess: () => {
      toast.success('File added to the library');
      setDisplayName('');
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Upload failed'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/media-library/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not remove'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Media library</CardTitle>
        <CardDescription>Images up to 5 MB (JPEG, PNG), video and audio up to 16 MB, documents up to 100 MB.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Can permission="inbox.reply">
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="library-name">Name (optional)</Label>
              <Input id="library-name" value={displayName} maxLength={240} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="library-file">File</Label>
              <Input
                id="library-file"
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = '';
                }}
              />
            </div>
            {upload.isPending && <span className="text-sm text-muted-foreground">Uploading…</span>}
          </div>
        </Can>
        <ul className="grid gap-2" data-testid="media-library">
          {items.data?.items.length === 0 && <li className="text-sm text-muted-foreground">The library is empty.</li>}
          {items.data?.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
              <span className="min-w-0 truncate">
                {ICON[item.kind]} {item.displayName ?? 'File'}{' '}
                <span className="text-xs text-muted-foreground">
                  {Math.ceil(item.sizeBytes / 1024)} KB · {formatDateTime(item.createdAt)}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                <a className="text-xs underline" href={`/api/inbox/media/${item.id}`} target="_blank" rel="noreferrer">
                  Open
                </a>
                <Can permission="media.manage">
                  <ConfirmDialog
                    trigger={
                      <Button variant="ghost" size="sm" className="text-destructive">
                        Remove
                      </Button>
                    }
                    title={`Remove "${item.displayName ?? 'this file'}"?`}
                    description="It disappears from the library. Chats that already sent it keep their copy."
                    confirmLabel="Remove"
                    confirmVariant="destructive"
                    onConfirm={() => remove.mutateAsync(item.id)}
                  />
                </Can>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
