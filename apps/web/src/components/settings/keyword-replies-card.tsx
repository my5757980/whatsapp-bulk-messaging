'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { useGlobalAttributes } from '@/lib/global-attributes';
import type { Template } from '@/lib/types';

// Feature 010 (US4, FR-017, FR-018): the confirmation sent after an opt-out or opt-in keyword, a text or an
// approved utility template, at most once a day per contact.

type Source = {
  source: 'field' | 'attribute' | 'global' | 'static';
  key?: string;
  value?: string;
  fallback?: string;
};
export interface KeywordReply {
  kind: 'NONE' | 'TEXT' | 'TEMPLATE';
  text: string | null;
  templateId: string | null;
  variables: Record<string, Source>;
}
interface KeywordReplies {
  optOut: KeywordReply;
  optIn: KeywordReply;
}

const repliesKey = ['settings', 'keyword-replies'] as const;
const NONE: KeywordReply = { kind: 'NONE', text: null, templateId: null, variables: {} };

/** What is sent: only the fields of the chosen kind. */
function body(r: KeywordReply) {
  if (r.kind === 'TEXT') return { kind: 'TEXT', text: r.text ?? '' };
  if (r.kind === 'TEMPLATE')
    return { kind: 'TEMPLATE', templateId: r.templateId, variables: r.variables };
  return { kind: 'NONE' };
}

export function KeywordRepliesCard({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const replies = useQuery({
    queryKey: repliesKey,
    queryFn: () => api<KeywordReplies>('/settings/keyword-replies'),
  });
  const templates = useQuery({
    queryKey: ['templates', { status: 'APPROVED' }],
    queryFn: () => api<Template[]>('/templates?status=APPROVED'),
  });
  const [optOut, setOptOut] = useState<KeywordReply>(NONE);
  const [optIn, setOptIn] = useState<KeywordReply>(NONE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fill the form once from the saved replies; later refetches never overwrite what is being typed.
  useEffect(() => {
    if (replies.data && !loaded) {
      setOptOut(replies.data.optOut);
      setOptIn(replies.data.optIn);
      setLoaded(true);
    }
  }, [replies.data, loaded]);
  const save = useMutation({
    mutationFn: () =>
      api<KeywordReplies>('/settings/keyword-replies', {
        method: 'PUT',
        json: { optOut: body(optOut), optIn: body(optIn) },
      }),
    onSuccess: (saved) => {
      setError(null);
      queryClient.setQueryData(repliesKey, saved);
      toast.success('Keyword replies saved');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const utility = (templates.data ?? []).filter((t) => t.category === 'UTILITY');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Keyword replies</CardTitle>
        <CardDescription>
          A confirmation sent after an opt-out or opt-in keyword, from the number the customer wrote
          to. At most one of each per contact a day; never to blocked contacts. Templates must be
          approved utility templates.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <fieldset disabled={!editable || !loaded} className="grid gap-6">
          <ReplyEditor
            id="opt-out-reply"
            title="After an opt-out keyword"
            value={optOut}
            onChange={setOptOut}
            templates={utility}
          />
          <ReplyEditor
            id="opt-in-reply"
            title="After an opt-in keyword"
            value={optIn}
            onChange={setOptIn}
            templates={utility}
          />
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {editable ? (
          <div>
            <Button
              type="button"
              onClick={() => save.mutate()}
              disabled={!loaded || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save replies'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReplyEditor({
  id,
  title,
  value,
  onChange,
  templates,
}: {
  id: string;
  title: string;
  value: KeywordReply;
  onChange: (next: KeywordReply) => void;
  templates: Template[];
}) {
  const globals = useGlobalAttributes(value.kind === 'TEMPLATE');
  const template = templates.find((t) => t.id === value.templateId);
  const choose = (templateId: string) => {
    const chosen = templates.find((t) => t.id === templateId);
    // Every variable starts mapped to the contact's name with a fallback, so the reply can always be sent.
    const variables = Object.fromEntries(
      (chosen?.variables ?? []).map((v) => [
        v.key,
        { source: 'field', key: 'name', fallback: 'there' } satisfies Source,
      ]),
    );
    onChange({ ...value, templateId: templateId || null, variables });
  };

  return (
    <div className="grid gap-2" data-testid={id}>
      <div className="text-sm font-medium">{title}</div>
      <div className="grid gap-1">
        <Label htmlFor={`${id}-kind`}>Reply</Label>
        <NativeSelect
          id={`${id}-kind`}
          value={value.kind}
          onChange={(e) => onChange({ ...NONE, kind: e.target.value as KeywordReply['kind'] })}
        >
          <option value="NONE">No reply</option>
          <option value="TEXT">Text</option>
          <option value="TEMPLATE">Approved utility template</option>
        </NativeSelect>
      </div>
      {value.kind === 'TEXT' ? (
        <div className="grid gap-1">
          <Label htmlFor={`${id}-text`}>Text</Label>
          <textarea
            id={`${id}-text`}
            className="min-h-[72px] rounded-md border bg-background px-3 py-2 text-sm"
            maxLength={1024}
            value={value.text ?? ''}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
        </div>
      ) : null}
      {value.kind === 'TEMPLATE' ? (
        <>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-template`}>Template</Label>
            <NativeSelect
              id={`${id}-template`}
              value={value.templateId ?? ''}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">Choose a utility template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </NativeSelect>
          </div>
          {template?.variables.map((v) => {
            const mapping = value.variables[v.key] ?? {
              source: 'field',
              key: 'name',
              fallback: 'there',
            };
            const set = (next: Source) =>
              onChange({ ...value, variables: { ...value.variables, [v.key]: next } });
            return (
              <div
                key={v.key}
                className="grid grid-cols-[90px_1fr_1fr_1fr] items-center gap-1 text-xs"
              >
                <span>{v.key}</span>
                <NativeSelect
                  aria-label={`${v.key} source`}
                  value={mapping.source}
                  onChange={(e) =>
                    set({ source: e.target.value as Source['source'], fallback: mapping.fallback })
                  }
                >
                  <option value="field">Contact field</option>
                  <option value="attribute">Attribute</option>
                  <option value="global">Global attribute</option>
                  <option value="static">Fixed text</option>
                </NativeSelect>
                {mapping.source === 'static' ? (
                  <Input
                    aria-label={`${v.key} value`}
                    value={mapping.value ?? ''}
                    onChange={(e) => set({ ...mapping, value: e.target.value })}
                  />
                ) : mapping.source === 'global' ? (
                  <NativeSelect
                    aria-label={`${v.key} global attribute`}
                    value={mapping.key ?? ''}
                    onChange={(e) => set({ ...mapping, key: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {(globals.data?.items ?? []).map((g) => (
                      <option key={g.id} value={g.key}>
                        {g.key}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    aria-label={`${v.key} key`}
                    placeholder={mapping.source === 'field' ? 'name or phone' : 'attribute key'}
                    value={mapping.key ?? ''}
                    onChange={(e) => set({ ...mapping, key: e.target.value })}
                  />
                )}
                <Input
                  aria-label={`${v.key} fallback`}
                  placeholder="fallback"
                  value={mapping.fallback ?? ''}
                  onChange={(e) => set({ ...mapping, fallback: e.target.value })}
                />
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
