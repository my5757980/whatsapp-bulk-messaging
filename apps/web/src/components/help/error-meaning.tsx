/** What a failure reason means and what to do (feature 009 US7, FR-028), shown under the reason. */
export function ErrorMeaning({ meaning, action }: { meaning?: string | null; action?: string | null }) {
  if (!meaning && !action) return null;
  return (
    <div className="mt-1 grid gap-0.5 text-xs" data-testid="error-meaning">
      {meaning ? <span className="text-muted-foreground">{meaning}</span> : null}
      {action ? (
        <span>
          <span className="font-medium">What to do:</span> {action}
        </span>
      ) : null}
    </div>
  );
}
