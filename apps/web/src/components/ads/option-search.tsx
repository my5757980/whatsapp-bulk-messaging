'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TargetingOption } from '@/lib/ads';
import { api } from '@/lib/api-client';

/** Searches Meta's places or interests and keeps the chosen ones as removable chips (feature 007 US2). */
export function OptionSearch({
  id,
  label,
  kind,
  value,
  onChange,
  disabled,
  max,
}: {
  id: string;
  label: string;
  kind: 'locations' | 'interests';
  value: TargetingOption[];
  onChange: (next: TargetingOption[]) => void;
  disabled?: boolean;
  max: number;
}) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const results = useQuery({
    queryKey: ['ads', 'targeting', kind, term],
    queryFn: () => api<TargetingOption[]>(`/ads/targeting/${kind}?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2 && !disabled,
    staleTime: 60_000,
  });
  const chosen = new Set(value.map((o) => `${o.type}:${o.key}`));

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} placeholder="Type at least 2 letters" value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
      {term.length >= 2 && results.data ? (
        <ul className="grid gap-1" data-testid={`${id}-results`}>
          {results.data.length === 0 ? <li className="text-sm text-muted-foreground">No matches.</li> : null}
          {results.data.slice(0, 8).map((o) => (
            <li key={`${o.type}:${o.key}`} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {o.name} <span className="text-muted-foreground">· {o.type}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={chosen.has(`${o.type}:${o.key}`) || value.length >= max}
                onClick={() => {
                  onChange([...value, o]);
                  setQ('');
                }}
              >
                Add {o.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.map((o) => (
            <Badge key={`${o.type}:${o.key}`} variant="secondary" className="gap-1">
              {o.name}
              {disabled ? null : (
                <button type="button" aria-label={`Remove ${o.name}`} className="ml-1" onClick={() => onChange(value.filter((x) => !(x.key === o.key && x.type === o.type)))}>
                  ×
                </button>
              )}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
