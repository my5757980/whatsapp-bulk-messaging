'use client';

import { Badge } from '@/components/ui/badge';
import { ADS_CHECK_LABEL, type AdsCheck } from '@/lib/ads';

const RESULT_VARIANT = { PASSED: 'success', WARNING: 'warning', FAILED: 'destructive' } as const;
const RESULT_LABEL = { PASSED: 'Passed', WARNING: 'Warning', FAILED: 'Failed' } as const;

/** The ads connection checks, each with its result and plain fix (feature 007 US1, FR-002). */
export function AdsCheckList({ checks }: { checks: AdsCheck[] }) {
  if (!checks.length) return <p className="text-sm text-muted-foreground">No checks have run yet.</p>;
  return (
    <ul className="grid gap-2">
      {checks.map((c) => (
        <li key={c.check} data-testid={`ads-check-${c.check}`} className="grid gap-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{ADS_CHECK_LABEL[c.check]}</span>
            <Badge variant={RESULT_VARIANT[c.result]}>{RESULT_LABEL[c.result]}</Badge>
          </div>
          <p className="text-sm">{c.detail}</p>
          {c.fix ? <p className="text-sm text-muted-foreground">{c.fix}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function AdsCheckBadge({ check }: { check: AdsCheck }) {
  return <Badge variant={RESULT_VARIANT[check.result]}>{RESULT_LABEL[check.result]}</Badge>;
}
