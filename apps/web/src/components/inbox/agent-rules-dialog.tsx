'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';

interface Rule {
  id?: string;
  kind: 'TAG' | 'ATTRIBUTE';
  tagId?: string;
  tagName?: string | null;
  attributeKey?: string;
  attributeValue?: string;
}

/**
 * Agent rules (T055, FR-028): the agent then sees only chats whose contact has one of these tags
 * or attribute values. No rules means no restriction.
 */
export function AgentRulesDialog({ userId, name }: { userId: string; name: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Rule[] | null>(null);
  const [tagId, setTagId] = useState('');
  const [attrKey, setAttrKey] = useState('');
  const [attrValue, setAttrValue] = useState('');

  const rules = useQuery({ queryKey: ['agent-rules', userId], queryFn: () => api<Rule[]>(`/users/${userId}/agent-rules`), enabled: open });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<Array<{ id: string; name: string }>>('/tags'), enabled: open });
  const attributes = useQuery({ queryKey: ['attributes'], queryFn: () => api<Array<{ key: string; label: string }>>('/attributes'), enabled: open });
  const current = draft ?? rules.data ?? [];

  const save = useMutation({
    mutationFn: () =>
      api<Rule[]>(`/users/${userId}/agent-rules`, {
        method: 'PUT',
        json: current.map((r) => (r.kind === 'TAG' ? { kind: 'TAG', tagId: r.tagId } : { kind: 'ATTRIBUTE', attributeKey: r.attributeKey, attributeValue: r.attributeValue })),
      }),
    onSuccess: (saved) => {
      toast.success(saved.length ? `${name} now sees only matching chats` : `${name} sees every chat again`);
      queryClient.setQueryData(['agent-rules', userId], saved);
      setDraft(null);
      setOpen(false);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'The rules could not be saved'),
  });

  const add = (rule: Rule) => setDraft([...current, rule]);
  const label = (r: Rule) =>
    r.kind === 'TAG' ? `Tag: ${r.tagName ?? tags.data?.find((t) => t.id === r.tagId)?.name ?? r.tagId}` : `${r.attributeKey} = ${r.attributeValue}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          Agent rules
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent rules for {name}</DialogTitle>
          <DialogDescription>The agent sees open chats whose contact matches any rule, plus chats they took. No rules: every chat.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-sm" aria-label="Rules">
          {current.length === 0 && <li className="text-muted-foreground">No rules — this agent sees every chat.</li>}
          {current.map((r, i) => (
            <li key={`${r.kind}-${r.tagId ?? r.attributeKey}-${r.attributeValue ?? ''}-${i}`} className="flex items-center justify-between rounded-md border px-2 py-1">
              <span>{label(r)}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(current.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="grid gap-2 border-t pt-3">
          <Label htmlFor="rule-tag">Add a tag</Label>
          <div className="flex gap-2">
            <NativeSelect id="rule-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">Choose a tag</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
            <Button
              type="button"
              variant="secondary"
              disabled={!tagId}
              onClick={() => {
                add({ kind: 'TAG', tagId });
                setTagId('');
              }}
            >
              Add
            </Button>
          </div>
          <Label htmlFor="rule-attr">Add an attribute value</Label>
          <div className="flex gap-2">
            <NativeSelect id="rule-attr" value={attrKey} onChange={(e) => setAttrKey(e.target.value)}>
              <option value="">Attribute</option>
              {attributes.data?.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </NativeSelect>
            <Input aria-label="Attribute value" placeholder="Value" value={attrValue} maxLength={200} onChange={(e) => setAttrValue(e.target.value)} />
            <Button
              type="button"
              variant="secondary"
              disabled={!attrKey || !attrValue.trim()}
              onClick={() => {
                add({ kind: 'ATTRIBUTE', attributeKey: attrKey, attributeValue: attrValue.trim() });
                setAttrValue('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => save.mutate()} disabled={save.isPending || rules.isLoading}>
            Save rules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
