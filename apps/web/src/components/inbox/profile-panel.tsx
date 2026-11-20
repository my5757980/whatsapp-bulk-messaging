'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import type { ConversationDetail } from '@/lib/inbox-types';
import { Can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import { JourneyList } from './journey-list';

const CONSENT = { OPTED_IN: 'Opted in', OPTED_OUT: 'Opted out', UNKNOWN: 'Unknown' } as const;

/**
 * Chat profile (T074, FR-033, FR-034): counters, source, first-message tag, recent campaigns,
 * attributes and tags (editable with contacts.manage), the journey, and block / unblock.
 */
export function ProfilePanel({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: queryKeys.inboxConversation(id), queryFn: () => api<ConversationDetail>(`/inbox/conversations/${id}`) });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<Array<{ id: string; name: string }>>('/tags') });
  const [attrKey, setAttrKey] = useState('');
  const [attrValue, setAttrValue] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(id) });
    void queryClient.invalidateQueries({ queryKey: ['journey', id] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
  };
  const edit = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/inbox/conversations/${id}/contact`, { method: 'PATCH', json: body }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? (error.details?.[0] ? `${error.details[0].field} ${error.details[0].issue}` : error.message) : 'Could not save'),
  });
  const block = useMutation({
    mutationFn: (blocked: boolean) => api(`/contacts/${detail.data?.profile.contactId}/block`, { method: blocked ? 'POST' : 'DELETE' }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not change blocking'),
  });

  const chat = detail.data;
  if (!chat) return null;
  const p = chat.profile;
  const tagIds = new Set(p.tags.map((t) => t.id));

  return (
    <aside className="hidden min-h-0 overflow-y-auto border-l p-4 text-sm lg:block" aria-label="Contact">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="font-semibold">{p.name ?? 'Contact'}</h3>
        {p.blocked && <Badge variant="destructive">Blocked</Badge>}
      </div>
      <dl className="grid gap-2">
        <Field label="Phone">{p.phone ?? '—'}</Field>
        <Field label="Last active">{chat.lastActiveAt ? new Date(chat.lastActiveAt).toLocaleString() : '—'}</Field>
        <Field label="Consent">{CONSENT[p.consentStatus]}</Field>
        <Field label="Source">{p.leadSource ?? '—'}</Field>
        <Field label="Messages">
          {chat.templateMessageCount} template · {chat.sessionMessageCount} replies · {chat.unresolvedRequests} open requests
        </Field>
        <Field label="First-message tag">
          <Can permission="contacts.manage" fallback={<span>{p.firstMessageTag?.name ?? '—'}</span>}>
            <NativeSelect aria-label="First-message tag" value={p.firstMessageTag?.id ?? ''} onChange={(e) => edit.mutate({ firstMessageTagId: e.target.value || null })}>
              <option value="">None</option>
              {tags.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </Can>
        </Field>
        <Field label="Tags">
          <span className="flex flex-wrap gap-1">
            {p.tags.map((t) => (
              <Badge key={t.id} variant="outline" className="gap-1">
                {t.name}
                <Can permission="contacts.manage">
                  <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => edit.mutate({ removeTagIds: [t.id] })}>
                    ×
                  </button>
                </Can>
              </Badge>
            ))}
            {p.tags.length === 0 && <span className="text-muted-foreground">None</span>}
          </span>
          <Can permission="contacts.manage">
            <NativeSelect aria-label="Add a tag" className="mt-1" value="" onChange={(e) => e.target.value && edit.mutate({ addTagIds: [e.target.value] })}>
              <option value="">Add a tag…</option>
              {tags.data
                ?.filter((t) => !tagIds.has(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </NativeSelect>
          </Can>
        </Field>
        <Field label="Attributes">
          <ul className="grid gap-0.5">
            {Object.entries(p.attributes).map(([key, value]) => (
              <li key={key}>
                <span className="text-muted-foreground">{key}:</span> {String(value)}
              </li>
            ))}
            {Object.keys(p.attributes).length === 0 && <li className="text-muted-foreground">None</li>}
          </ul>
          <Can permission="contacts.manage">
            <form
              className="mt-1 flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!attrKey.trim()) return;
                edit.mutate({ attributes: { [attrKey.trim()]: attrValue.trim() || null } });
                setAttrKey('');
                setAttrValue('');
              }}
            >
              <Input aria-label="Attribute key" placeholder="key" value={attrKey} onChange={(e) => setAttrKey(e.target.value)} />
              <Input aria-label="Attribute value" placeholder="value (empty removes)" value={attrValue} onChange={(e) => setAttrValue(e.target.value)} />
              <Button type="submit" size="sm" variant="secondary">
                Set
              </Button>
            </form>
          </Can>
        </Field>
        {chat.recentCampaigns.length > 0 && (
          <Field label="Recent campaigns">
            <ul className="grid gap-0.5">
              {chat.recentCampaigns.map((c) => (
                <li key={`${c.campaignId}-${c.sentAt}`}>
                  {c.name} <span className="text-xs text-muted-foreground">({c.status.toLowerCase()})</span>
                </li>
              ))}
            </ul>
          </Field>
        )}
      </dl>
      {p.contactId && (
        <Can permission="inbox.reply">
          <div className="mt-4">
            {p.blocked ? (
              <Button variant="outline" size="sm" onClick={() => block.mutate(false)} disabled={block.isPending}>
                Unblock contact
              </Button>
            ) : (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="sm" className="text-destructive">
                    Block contact
                  </Button>
                }
                title="Block this contact?"
                description="Their messages are still saved but raise no alerts or automatic replies, and the chat leaves the live lists. Consent does not change."
                confirmLabel="Block"
                confirmVariant="destructive"
                onConfirm={() => block.mutateAsync(true)}
              />
            )}
          </div>
        </Can>
      )}
      <JourneyList conversationId={id} />
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
