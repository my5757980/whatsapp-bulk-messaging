'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const VARIABLE = /\{(first_name|last_name|name|phone|attr:[A-Za-z0-9_]+|answer:[a-z][a-z0-9_]{0,39})\}/g;

/** The variables used in some texts, in order of first use. */
export function variablesIn(texts: Array<string | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) for (const match of (text ?? '').matchAll(VARIABLE)) found.add(match[1]!);
  return [...found];
}

/**
 * Per-step fallbacks (FR-017): for each variable the step's texts use, what to show when the value is
 * empty (for example "there" for an unknown first name). Empty means the variable renders as nothing.
 */
export function FallbacksEditor({ texts, fallbacks, onChange }: { texts: Array<string | undefined>; fallbacks: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const variables = variablesIn(texts).filter((name) => name.length <= 60);
  if (!variables.length) return null;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">When a value is empty, show</legend>
      {variables.map((name) => (
        <div key={name} className="grid gap-1">
          <Label htmlFor={`fallback-${name}`} className="text-xs font-normal">
            Instead of {`{${name}}`}
          </Label>
          <Input
            id={`fallback-${name}`}
            value={fallbacks[name] ?? ''}
            maxLength={200}
            placeholder="Nothing"
            onChange={(e) => {
              const next = { ...fallbacks };
              if (e.target.value) next[name] = e.target.value;
              else delete next[name];
              onChange(next);
            }}
          />
        </div>
      ))}
    </fieldset>
  );
}
