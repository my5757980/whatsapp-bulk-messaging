'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

export interface MappingSource {
  source: 'column' | 'static';
  key?: string;
  value?: string;
  fallback?: string | null;
}

/** Template variables filled from the lead's answers or fixed text (feature 007 US7, the 001 mapping format). */
export function WelcomeMapping({
  variables,
  answers,
  value,
  onChange,
}: {
  variables: Array<{ key: string; example?: string }>;
  answers: Array<{ key: string; label: string }>;
  value: Record<string, MappingSource>;
  onChange: (next: Record<string, MappingSource>) => void;
}) {
  if (!variables.length) return <p className="text-xs text-muted-foreground">This template has no variables.</p>;
  const set = (key: string, next: MappingSource) => onChange({ ...value, [key]: next });
  return (
    <div className="grid gap-2">
      {variables.map((v) => {
        const current = value[v.key] ?? { source: 'column', key: answers[0]?.key ?? 'full_name', fallback: 'there' };
        const choice = current.source === 'static' ? '__fixed' : (current.key ?? '');
        return (
          <div key={v.key} className="grid gap-2 sm:grid-cols-3 sm:items-end">
            <div className="grid gap-1">
              <Label htmlFor={`map-${v.key}`}>{v.key}</Label>
              <NativeSelect
                id={`map-${v.key}`}
                value={choice}
                onChange={(e) => set(v.key, e.target.value === '__fixed' ? { source: 'static', value: current.value ?? '' } : { source: 'column', key: e.target.value, fallback: current.fallback ?? 'there' })}
              >
                {answers.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
                <option value="__fixed">Fixed text</option>
              </NativeSelect>
            </div>
            {current.source === 'static' ? (
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor={`map-text-${v.key}`}>Text</Label>
                <Input id={`map-text-${v.key}`} value={current.value ?? ''} onChange={(e) => set(v.key, { source: 'static', value: e.target.value })} placeholder={v.example} />
              </div>
            ) : (
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor={`map-fallback-${v.key}`}>When the answer is empty</Label>
                <Input id={`map-fallback-${v.key}`} value={current.fallback ?? ''} onChange={(e) => set(v.key, { ...current, fallback: e.target.value })} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
