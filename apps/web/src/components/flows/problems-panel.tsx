import type { Problem } from '@wbm/shared';

/** What blocks publishing (FR-003); a problem in a step selects and shows that step. */
export function ProblemsPanel({ problems, onFocusStep }: { problems: Problem[]; onFocusStep: (stepId: string) => void }) {
  return (
    <section aria-labelledby="problems-title" className="grid gap-2 rounded-lg border bg-card p-3">
      <h2 id="problems-title" className="text-sm font-semibold">
        {problems.length ? `Problems (${problems.length})` : 'Problems'}
      </h2>
      {problems.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-problems">
          Nothing blocks publishing.
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="problems">
          {problems.map((problem, i) => {
            const stepId = problem.stepId;
            return (
              <li key={`${problem.code}:${stepId ?? problem.triggerId ?? ''}:${problem.field ?? ''}:${i}`}>
                {stepId ? (
                  <button type="button" className="text-left text-sm text-destructive hover:underline" onClick={() => onFocusStep(stepId)}>
                    {problem.message}
                  </button>
                ) : (
                  <span className="text-sm text-destructive">{problem.message}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
