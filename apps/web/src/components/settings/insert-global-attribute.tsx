'use client';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useGlobalAttributes, type GlobalAttribute } from '@/lib/global-attributes';

/**
 * Feature 010 (US3): a menu of global attributes. The live chat composer inserts the current value; the saved
 * reply editor inserts the `{global:key}` placeholder so the value is read when the reply is sent.
 */
export function InsertGlobalAttribute({ onInsert, disabled }: { onInsert: (attribute: GlobalAttribute) => void; disabled?: boolean }) {
  const globals = useGlobalAttributes();
  const items = globals.data?.items ?? [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          Insert global attribute
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-72 overflow-y-auto">
        <DropdownMenuLabel>Global attributes</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!items.length ? <p className="px-2 py-3 text-sm text-muted-foreground">{globals.isLoading ? 'Loading…' : 'No global attributes yet.'}</p> : null}
        {items.map((g) => (
          <DropdownMenuItem key={g.id} onSelect={() => onInsert(g)} disabled={!g.value.trim()} className="flex flex-col items-start gap-0.5">
            <span className="font-mono text-xs">{g.key}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{g.value.trim() ? g.value : 'No value yet'}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inserts text at the cursor of a text box (or at the end) and returns the new text. */
export function insertAtCursor(box: HTMLTextAreaElement | null, current: string, text: string): string {
  if (!box) return current ? `${current}${current.endsWith(' ') ? '' : ' '}${text}` : text;
  const start = box.selectionStart ?? current.length;
  const end = box.selectionEnd ?? current.length;
  return `${current.slice(0, start)}${text}${current.slice(end)}`;
}
