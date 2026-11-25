'use client';

import { Badge } from '@/components/ui/badge';
import { WIZARD_CHECK_LABEL, type WizardCheck } from '@/lib/integrations';

const RESULT_VARIANT = { PASSED: 'success', WARNING: 'warning', FAILED: 'destructive' } as const;
const RESULT_LABEL = { PASSED: 'Passed', WARNING: 'Warning', FAILED: 'Failed' } as const;

/** The number wizard's checks, each with its result and plain fix (feature 006 US8, FR-052). */
export function WizardCheckList({ checks, renderFix }: { checks: WizardCheck[]; renderFix?: (check: WizardCheck) => React.ReactNode }) {
  return (
    <ul className="grid gap-2">
      {checks.map((c) => (
        <li key={c.check} data-testid={`wizard-check-${c.check}`} className="grid gap-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{WIZARD_CHECK_LABEL[c.check]}</span>
            <Badge variant={RESULT_VARIANT[c.result]}>{RESULT_LABEL[c.result]}</Badge>
          </div>
          <p className="text-sm">{c.detail}</p>
          {c.fix ? <p className="text-sm text-muted-foreground">{c.fix}</p> : null}
          {c.fixAction && renderFix ? renderFix(c) : null}
        </li>
      ))}
    </ul>
  );
}
