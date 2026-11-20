'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checkChatMedia } from '@wbm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface MediaItem {
  id: string;
  displayName: string | null;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'video' | 'audio' | 'document';
  createdAt: string;
}

export const mediaLibraryKey = ['media-library'] as const;
const ICON = { image: '🖼️', video: '🎥', audio: '🎵', document: '📄' } as const;

/** Uploads a file to the media library after the chat limits check (FR-015). */
export async function uploadToLibrary(file: File, displayName?: string): Promise<MediaItem> {
  const check = checkChatMedia(file.type || 'application/octet-stream', file.size);
  if (!check.ok) throw new Error(check.message);
  const form = new FormData();
  form.set('file', file);
  if (displayName) form.set('displayName', displayName);
  return api<MediaItem>('/media-library', { method: 'POST', body: form });
}

/**
 * Attach a file to a reply (T066): from the media library or from the computer (stored in the
 * library first, so it can be reused), with an optional caption (none for audio).
 */
export function MediaPicker({ onSend, disabled }: { onSend: (item: MediaItem, caption: string) => void; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<MediaItem | null>(null);
  const [caption, setCaption] = useState('');
  const library = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'), enabled: open });

  const upload = useMutation({
    mutationFn: (file: File) => uploadToLibrary(file),
    onSuccess: (item) => {
      setChosen(item);
      void queryClient.invalidateQueries({ queryKey: mediaLibraryKey });
    },
    onError: (error) => toast.error(error instanceof ApiError || error instanceof Error ? error.message : 'The file could not be uploaded'),
  });

  const reset = () => {
    setChosen(null);
    setCaption('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled}>
          Attach
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a file</DialogTitle>
          <DialogDescription>Images up to 5 MB, video and audio up to 16 MB, documents up to 100 MB.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="attach-file">From your computer</Label>
            <Input
              id="attach-file"
              type="file"
              accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
              }}
            />
            {upload.isPending && <span className="text-xs text-muted-foreground">Uploading…</span>}
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium">Or from the media library</span>
            <ul className="grid max-h-56 gap-1 overflow-y-auto" aria-label="Media library">
              {library.data?.items.length === 0 && <li className="text-xs text-muted-foreground">The library is empty.</li>}
              {library.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(item)}
                    className={cn('w-full rounded-md border px-2 py-1 text-left text-sm hover:bg-accent', chosen?.id === item.id && 'border-primary bg-accent')}
                  >
                    {ICON[item.kind]} {item.displayName ?? 'File'} <span className="text-xs text-muted-foreground">({Math.ceil(item.sizeBytes / 1024)} KB)</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {chosen && chosen.kind !== 'audio' && (
            <div className="grid gap-1">
              <Label htmlFor="attach-caption">Caption (optional)</Label>
              <Input id="attach-caption" value={caption} maxLength={1024} onChange={(e) => setCaption(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              if (!chosen) return;
              onSend(chosen, chosen.kind === 'audio' ? '' : caption);
              setOpen(false);
              reset();
            }}
            disabled={!chosen || upload.isPending}
          >
            Send {chosen ? `"${chosen.displayName ?? 'file'}"` : 'file'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
