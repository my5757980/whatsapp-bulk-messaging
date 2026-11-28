'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import type { CampaignCardMedia, MediaCheckResult, Template } from '@/lib/types';

/** The carousel's cards and their header format (feature 009, research R6). */
export function carouselCards(template: Template | undefined): Array<{ format: 'IMAGE' | 'VIDEO'; body: string }> {
  const carousel = template?.components.find((c) => c.type.toUpperCase() === 'CAROUSEL');
  return (carousel?.cards ?? []).map((card) => {
    const parts = card.components ?? [];
    const format = parts.find((p) => p.type.toUpperCase() === 'HEADER')?.format?.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE';
    return { format, body: parts.find((p) => p.type.toUpperCase() === 'BODY')?.text ?? '' };
  });
}

const RESULT_TEXT: Record<MediaCheckResult['cardMedia'][number]['result'], string> = {
  READY: 'Ready',
  WRONG_TYPE: 'Wrong file type',
  TOO_LARGE: 'File too large',
  UPLOAD_FAILED: 'Upload failed',
};

/**
 * Carousel card files for this campaign (feature 009 US2, FR-008): each card uses the template's sample
 * unless another library file is chosen. The check uploads each file to the sending number once
 * (launch does the same) and reports each card.
 */
export function CardMediaCard({ campaignId, template, value, onChange }: { campaignId: string; template: Template | undefined; value: CampaignCardMedia[]; onChange: (next: CampaignCardMedia[]) => void }) {
  const cards = carouselCards(template);
  const library = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'), enabled: cards.length > 0 });
  const [results, setResults] = useState<MediaCheckResult['cardMedia'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: async () => {
      await api(`/campaigns/${campaignId}`, { method: 'PATCH', json: { cardMedia: value.length ? value : null } });
      return api<MediaCheckResult>(`/campaigns/${campaignId}/media-check`, { method: 'POST' });
    },
    onSuccess: (result) => {
      setError(null);
      setResults(result.cardMedia);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!cards.length) return null;
  const choose = (cardIndex: number, mediaAssetId: string) => {
    setResults(null);
    const rest = value.filter((c) => c.cardIndex !== cardIndex);
    onChange(mediaAssetId ? [...rest, { cardIndex, mediaAssetId }].sort((a, b) => a.cardIndex - b.cardIndex) : rest);
  };

  return (
    <section aria-labelledby="card-media-title" className="grid gap-3 rounded-md border p-4" data-testid="card-media">
      <div>
        <h3 id="card-media-title" className="text-sm font-medium">
          Card files
        </h3>
        <p className="text-xs text-muted-foreground">Each card shows the template&apos;s file unless you choose another one from the media library.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((card, i) => {
          const chosen = value.find((c) => c.cardIndex === i)?.mediaAssetId ?? '';
          const kind = card.format === 'VIDEO' ? 'video' : 'image';
          const result = results?.find((r) => r.cardIndex === i);
          return (
            <div key={i} className="grid gap-1.5 rounded-md border p-3" data-testid={`card-media-${i}`}>
              <Label htmlFor={`card-media-${i}`}>
                Card {i + 1} {card.format === 'VIDEO' ? 'video' : 'image'}
              </Label>
              {card.body ? <p className="truncate text-xs text-muted-foreground">{card.body}</p> : null}
              <NativeSelect id={`card-media-${i}`} value={chosen} onChange={(e) => choose(i, e.target.value)}>
                <option value="">The template&apos;s file</option>
                {(library.data?.items ?? [])
                  .filter((m) => m.kind === kind)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </option>
                  ))}
              </NativeSelect>
              {result ? (
                <p className={result.result === 'READY' ? 'text-xs text-emerald-700' : 'text-xs text-destructive'} data-testid={`card-media-result-${i}`}>
                  {RESULT_TEXT[result.result]}
                  {result.detail ? ` — ${result.detail}` : ''}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? 'Checking…' : 'Check card files'}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
