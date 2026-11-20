'use client';

import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import type { Template } from '@/lib/types';
import { mediaLibraryKey, type MediaItem } from './media-picker';

export type VariableSource = { source: 'field' | 'attribute' | 'static'; key?: string; value?: string; fallback?: string };
export type AutoContent =
  | { kind: 'TEXT'; text: string }
  | { kind: 'TEMPLATE'; templateId: string; variables: Record<string, VariableSource> }
  | { kind: 'IMAGE' | 'FILE'; mediaAssetId: string; text?: string };

/** Starting content for a kind. */
export function emptyContent(kind: AutoContent['kind']): AutoContent {
  if (kind === 'TEXT') return { kind, text: '' };
  if (kind === 'TEMPLATE') return { kind, templateId: '', variables: {} };
  return { kind, mediaAssetId: '' };
}

/**
 * Welcome / off-hours content (T082, data-model §3 AutoContent): text, an approved template with
 * its variables mapped to contact fields, attributes or fixed values (each with a fallback), or an
 * image or file from the media library.
 */
export function AutoContentEditor({ id, value, onChange }: { id: string; value: AutoContent; onChange: (next: AutoContent) => void }) {
  const templates = useQuery({ queryKey: ['templates', { status: 'APPROVED' }], queryFn: () => api<Template[]>('/templates?status=APPROVED'), enabled: value.kind === 'TEMPLATE' });
  const media = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60'), enabled: value.kind === 'IMAGE' || value.kind === 'FILE' });
  const template = value.kind === 'TEMPLATE' ? templates.data?.find((t) => t.id === value.templateId) : undefined;

  return (
    <div className="grid gap-2">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-kind`}>Message type</Label>
        <NativeSelect id={`${id}-kind`} value={value.kind} onChange={(e) => onChange(emptyContent(e.target.value as AutoContent['kind']))}>
          <option value="TEXT">Text</option>
          <option value="TEMPLATE">Approved template</option>
          <option value="IMAGE">Image from the media library</option>
          <option value="FILE">File from the media library</option>
        </NativeSelect>
      </div>

      {value.kind === 'TEXT' && (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-text`}>Text</Label>
          <textarea id={`${id}-text`} className="min-h-[72px] rounded-md border bg-background px-3 py-2 text-sm" maxLength={4096} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
        </div>
      )}

      {value.kind === 'TEMPLATE' && (
        <>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-template`}>Template</Label>
            <NativeSelect id={`${id}-template`} value={value.templateId} onChange={(e) => onChange({ kind: 'TEMPLATE', templateId: e.target.value, variables: {} })}>
              <option value="">Choose a template</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </NativeSelect>
          </div>
          {template?.variables.map((v) => {
            const mapping = value.variables[v.key] ?? { source: 'field', key: 'name', fallback: '' };
            const set = (next: VariableSource) => onChange({ ...value, variables: { ...value.variables, [v.key]: next } });
            return (
              <div key={v.key} className="grid grid-cols-[90px_1fr_1fr_1fr] items-center gap-1 text-xs">
                <span>{v.key}</span>
                <NativeSelect aria-label={`${v.key} source`} value={mapping.source} onChange={(e) => set({ source: e.target.value as VariableSource['source'], fallback: mapping.fallback })}>
                  <option value="field">Contact field</option>
                  <option value="attribute">Attribute</option>
                  <option value="static">Fixed text</option>
                </NativeSelect>
                {mapping.source === 'static' ? (
                  <Input aria-label={`${v.key} value`} value={mapping.value ?? ''} onChange={(e) => set({ ...mapping, value: e.target.value })} />
                ) : (
                  <Input aria-label={`${v.key} key`} placeholder={mapping.source === 'field' ? 'name or phone' : 'attribute key'} value={mapping.key ?? ''} onChange={(e) => set({ ...mapping, key: e.target.value })} />
                )}
                <Input aria-label={`${v.key} fallback`} placeholder="fallback" value={mapping.fallback ?? ''} onChange={(e) => set({ ...mapping, fallback: e.target.value })} />
              </div>
            );
          })}
        </>
      )}

      {(value.kind === 'IMAGE' || value.kind === 'FILE') && (
        <>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-media`}>{value.kind === 'IMAGE' ? 'Image' : 'File'}</Label>
            <NativeSelect id={`${id}-media`} value={value.mediaAssetId} onChange={(e) => onChange({ ...value, mediaAssetId: e.target.value })}>
              <option value="">Choose from the media library</option>
              {media.data?.items
                .filter((m) => (value.kind === 'IMAGE' ? m.kind === 'image' : m.kind !== 'image'))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-caption`}>Caption (optional)</Label>
            <Input id={`${id}-caption`} value={value.text ?? ''} maxLength={1024} onChange={(e) => onChange({ ...value, text: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}
