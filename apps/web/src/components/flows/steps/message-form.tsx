'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { MediaPicker, mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api-client';
import { FallbacksEditor } from './fallbacks-editor';
import { TEXTAREA_CLASS, VariablesHint } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

/** Message step: text, or a file from the 002 media library with the text as its caption. */
export function MessageForm({ step, graph, onPatch }: { step: StepOf<'message'>; graph: FlowGraph; onPatch: StepPatch<StepOf<'message'>> }) {
  const library = useQuery({
    queryKey: mediaLibraryKey,
    queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'),
    enabled: step.mediaAssetId !== null,
  });
  const file = library.data?.items.find((item) => item.id === step.mediaAssetId);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor="message-text">{step.mediaAssetId ? 'Caption' : 'Message'}</Label>
        <textarea
          id="message-text"
          className={TEXTAREA_CLASS}
          value={step.text}
          maxLength={FLOW_LIMITS.messageText}
          onChange={(e) => onPatch({ text: e.target.value }, 'text')}
        />
        <VariablesHint />
      </div>
      <div className="grid gap-1">
        <span className="text-sm font-medium">File (optional)</span>
        {step.mediaAssetId ? (
          <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
            <span className="truncate">{file?.displayName ?? 'File from the media library'}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => onPatch({ mediaAssetId: null })}>
              Remove
            </Button>
          </div>
        ) : (
          <MediaPicker purpose="choose" onSend={(item) => onPatch({ mediaAssetId: item.id })} />
        )}
      </div>
      <GoesToSelect id="message-next" label="Then go to" graph={graph} fromId={step.id} value={step.next} onChange={(next) => onPatch({ next })} />
      <FallbacksEditor texts={[step.text]} fallbacks={step.fallbacks} onChange={(fallbacks) => onPatch({ fallbacks }, 'fallbacks')} />
    </div>
  );
}
