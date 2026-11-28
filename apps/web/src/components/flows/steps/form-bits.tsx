'use client';

// Small shared pieces of the step forms (003 T027, T036).
import { globalPlaceholder, useGlobalAttributes } from '@/lib/global-attributes';

/** Answer names start with a letter and use lower-case letters, digits and _ (40 at most). */
export function cleanAnswerName(value: string): string | undefined {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
  return cleaned || undefined;
}

export const TEXTAREA_CLASS =
  'min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The variables a flow text can use (contact values as in live chat replies, earlier answers and global attributes). */
export function VariablesHint() {
  const globals = useGlobalAttributes();
  const keys = (globals.data?.items ?? []).map((g) => globalPlaceholder(g.key));
  return (
    <p className="text-xs text-muted-foreground">
      Contact details: {'{first_name}'}, {'{name}'}, {'{phone}'}, {'{attr:key}'}. Earlier answers: {'{answer:name}'}.
      {keys.length ? ` Global attributes: ${keys.join(', ')}.` : ''}
    </p>
  );
}
