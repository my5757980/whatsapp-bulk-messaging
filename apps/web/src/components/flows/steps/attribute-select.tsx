'use client';

import { useQuery } from '@tanstack/react-query';
import type { AnswerSpec } from '@wbm/shared';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition } from '@/lib/types';

/** What kind of value a step saves: a question's answer kind, or an option title (text). */
export type SavedKind = AnswerSpec['kind'];

/** TEXT takes any answer; NUMBER and DATE take answers of that kind; BOOLEAN is not an answer target. */
export function attributeFits(attribute: Pick<AttributeDefinition, 'type'>, kind: SavedKind): boolean {
  return attribute.type === 'TEXT' || (attribute.type === 'NUMBER' && kind === 'number') || (attribute.type === 'DATE' && kind === 'date');
}

/** Picks the contact attribute an answer is saved to (FR-010), offering only attributes that fit. */
export function AttributeSelect({ id, kind, value, onChange }: { id: string; kind: SavedKind; value: string | undefined; onChange: (key: string | undefined) => void }) {
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const options = (attributes.data ?? []).filter((a) => attributeFits(a, kind));
  const unavailable = value !== undefined && attributes.isSuccess && !options.some((a) => a.key === value);
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>Save to contact attribute (optional)</Label>
      <NativeSelect id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Do not save</option>
        {unavailable && <option value={value}>{value} (not available)</option>}
        {options.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label} ({a.key})
          </option>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">Text attributes take any answer; number and date attributes take answers of that kind.</p>
    </div>
  );
}
