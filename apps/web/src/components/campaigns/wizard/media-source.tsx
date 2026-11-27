'use client';

import { useQuery } from '@tanstack/react-query';
import { mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import type { Template, VariableSource } from '@/lib/types';

/** The header media of a campaign: a library file, or a web address from one value, a column or an attribute (feature 009, research R9). */
export type MediaChoice = { kind: 'file'; mediaAssetId: string } | { kind: 'address'; source: VariableSource };

export const HEADER_MEDIA_KEY = 'HEADER.media';
const KIND = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' } as const;

/** The template's media header format, if it has one. */
export function headerMediaFormat(template: Template | undefined): 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null {
  if (!template || template.kind === 'CAROUSEL' || template.kind === 'AUTHENTICATION') return null;
  const format = template.components.find((c) => c.type.toUpperCase() === 'HEADER')?.format?.toUpperCase();
  return format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT' ? format : null;
}

export function mediaChoiceFrom(headerMediaAssetId: string | null, mapping: Record<string, VariableSource>): MediaChoice {
  const address = mapping[HEADER_MEDIA_KEY];
  if (address) return { kind: 'address', source: address };
  return { kind: 'file', mediaAssetId: headerMediaAssetId ?? '' };
}

export function mediaChoiceComplete(choice: MediaChoice): boolean {
  if (choice.kind === 'file') return Boolean(choice.mediaAssetId);
  return choice.source.source === 'static' ? /^https:\/\/\S+$/.test((choice.source.value ?? '').trim()) : Boolean(choice.source.key?.trim());
}

/** What the campaign saves: the file, or the address mapping under HEADER.media. */
export function mediaChoicePatch(choice: MediaChoice): { headerMediaAssetId: string | null; address: VariableSource | null } {
  if (choice.kind === 'file') return { headerMediaAssetId: choice.mediaAssetId || null, address: null };
  const s = choice.source;
  return { headerMediaAssetId: null, address: s.source === 'static' ? { source: 'static', value: (s.value ?? '').trim() } : { source: s.source, key: (s.key ?? '').trim() } };
}

/**
 * The header image, video or document for this campaign (feature 009 US4, FR-021): a file from the media
 * library for everyone, or a web address for each recipient. Addresses must be public https links; launch
 * checks them (a sample above 1,000 distinct ones).
 */
export function MediaSourceCard({ format, value, onChange, columns, allowColumn }: { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; value: MediaChoice; onChange: (next: MediaChoice) => void; columns: string[]; allowColumn: boolean }) {
  const library = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60') });
  const word = format === 'IMAGE' ? 'image' : format === 'VIDEO' ? 'video' : 'document';
  const mode = value.kind === 'file' ? 'file' : value.source.source;
  const setMode = (next: string) =>
    onChange(next === 'file' ? { kind: 'file', mediaAssetId: '' } : { kind: 'address', source: next === 'static' ? { source: 'static', value: '' } : { source: next as VariableSource['source'], key: '' } });
  return (
    <section aria-labelledby="media-source-title" className="grid gap-3 rounded-md border p-4" data-testid="media-source">
      <div>
        <h3 id="media-source-title" className="text-sm font-medium">
          Header {word}
        </h3>
        <p className="text-xs text-muted-foreground">Send one file to everyone, or a web address for each recipient (secure https links only).</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="media-source-mode">Where the {word} comes from</Label>
          <NativeSelect id="media-source-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="file">A file from the media library</option>
            <option value="static">One web address for everyone</option>
            {allowColumn ? <option value="column">A web address from an uploaded column</option> : null}
            <option value="attribute">A web address from a contact attribute</option>
          </NativeSelect>
        </div>
        {value.kind === 'file' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="media-source-file">File</Label>
            <NativeSelect id="media-source-file" value={value.mediaAssetId} onChange={(e) => onChange({ kind: 'file', mediaAssetId: e.target.value })}>
              <option value="">Choose a file…</option>
              {(library.data?.items ?? [])
                .filter((m) => m.kind === KIND[format])
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
            </NativeSelect>
          </div>
        ) : value.source.source === 'static' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="media-source-value">Address</Label>
            <Input id="media-source-value" value={value.source.value ?? ''} placeholder="https://files.example.com/brochure.pdf" onChange={(e) => onChange({ kind: 'address', source: { source: 'static', value: e.target.value } })} />
            {(value.source.value ?? '').trim() && !mediaChoiceComplete(value) ? <p className="text-xs text-destructive">Enter a full address starting with https://</p> : null}
          </div>
        ) : value.source.source === 'column' && columns.length ? (
          <div className="grid gap-1.5">
            <Label htmlFor="media-source-value">Column</Label>
            <NativeSelect id="media-source-value" value={value.source.key ?? ''} onChange={(e) => onChange({ kind: 'address', source: { source: 'column', key: e.target.value } })}>
              <option value="">Choose a column…</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="media-source-value">{value.source.source === 'column' ? 'Column' : 'Attribute key'}</Label>
            <Input id="media-source-value" value={value.source.key ?? ''} placeholder={value.source.source === 'column' ? 'invoice_url' : 'brochure_url'} onChange={(e) => onChange({ kind: 'address', source: { source: value.source.source, key: e.target.value } })} />
          </div>
        )}
      </div>
      {value.kind === 'address' && value.source.source !== 'static' ? <p className="text-xs text-muted-foreground">Recipients without an address are skipped as “missing media address”.</p> : null}
    </section>
  );
}
