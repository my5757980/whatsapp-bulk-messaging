'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { MessageOnWhatsApp } from '@/components/inbox/message-on-whatsapp';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage, toastError } from '@/lib/errors';
import { consentLabel, formatDateTime, titleCase } from '@/lib/format';
import { Can, usePermissions } from '@/lib/permissions';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition, ConsentStatusValue, ContactDetail } from '@/lib/types';

/** Contact detail: profile, tags, attributes, consent history and deletion (T128). */
export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const contact = useQuery({
    queryKey: queryKeys.contact(id),
    queryFn: () => api<ContactDetail>(`/contacts/${id}`),
  });
  const attributes = useQuery({
    queryKey: queryKeys.attributes,
    queryFn: () => api<AttributeDefinition[]>('/attributes'),
  });

  if (contact.isLoading || attributes.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (contact.error || !contact.data)
    return <p className="text-sm text-destructive">{errorMessage(contact.error)}</p>;
  // Remount the editors when the contact changes so their state starts from the saved values.
  return (
    <ContactView
      key={JSON.stringify(contact.data)}
      contact={contact.data}
      definitions={attributes.data ?? []}
    />
  );
}

function ContactView({
  contact,
  definitions,
}: {
  contact: ContactDetail;
  definitions: AttributeDefinition[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('contacts.manage');
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentStatusValue>(contact.consentStatus);
  const [note, setNote] = useState('');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ContactDetail>(`/contacts/${contact.id}`, { method: 'PATCH', json: body }),
    onSuccess: async () => {
      toast.success('Contact saved');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.contact(contact.id) });
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const attributeValues: Record<string, unknown> = {};
    for (const def of definitions) {
      const raw = String(form.get(`attr-${def.key}`) ?? '').trim();
      const before = contact.attributes[def.key];
      if (!raw) {
        if (before !== undefined) attributeValues[def.key] = null;
        continue;
      }
      attributeValues[def.key] = raw;
    }
    const name = String(form.get('name') ?? '').trim();
    save.mutate({
      name: name || null,
      tags: String(form.get('tags') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      attributes: attributeValues,
    });
  }

  function submitConsent(event: FormEvent) {
    event.preventDefault();
    setError(null);
    save.mutate({
      consentStatus: consent,
      ...(note.trim() ? { consentSourceNote: note.trim() } : {}),
    });
  }

  return (
    <div className="grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/contacts" className="text-sm text-muted-foreground hover:underline">
            ← Contacts
          </Link>
          <h1 className="text-2xl font-semibold">{contact.name ?? 'Unnamed contact'}</h1>
          <p className="text-sm text-muted-foreground">
            {contact.phone} · {contact.countryCode} · added {formatDateTime(contact.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Can permission="inbox.reply">
            <MessageOnWhatsApp contactId={contact.id} />
          </Can>
          <Can permission="contacts.delete">
            <ConfirmDialog
              trigger={<Button variant="destructive">Delete contact data</Button>}
              title="Delete this contact's personal data?"
              description="The contact, consent history and uploaded details are removed. Campaign totals keep delivery outcomes without the phone number. This cannot be undone."
              confirmLabel="Delete data"
              confirmVariant="destructive"
              onConfirm={() =>
                api(`/contacts/${contact.id}`, { method: 'DELETE' })
                  .then(() => {
                    toast.success('Contact data deleted');
                    void queryClient.invalidateQueries({ queryKey: ['contacts'] });
                    router.replace('/contacts');
                  })
                  .catch(toastError)
              }
            />
          </Can>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitProfile} className="grid gap-4">
            <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={contact.name ?? ''} maxLength={120} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="tags">Tags (comma separated)</Label>
                <Input id="tags" name="tags" defaultValue={contact.tags.join(', ')} />
              </div>
              {definitions.map((def) => {
                const value = contact.attributes[def.key];
                return (
                  <div key={def.key} className="grid gap-1.5">
                    <Label htmlFor={`attr-${def.key}`}>
                      {def.label}{' '}
                      <span className="text-xs text-muted-foreground">
                        ({def.type.toLowerCase()})
                      </span>
                    </Label>
                    {def.type === 'BOOLEAN' ? (
                      <NativeSelect
                        id={`attr-${def.key}`}
                        name={`attr-${def.key}`}
                        defaultValue={value === undefined ? '' : String(value)}
                      >
                        <option value="">Not set</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </NativeSelect>
                    ) : (
                      <Input
                        id={`attr-${def.key}`}
                        name={`attr-${def.key}`}
                        type={
                          def.type === 'DATE' ? 'date' : def.type === 'NUMBER' ? 'number' : 'text'
                        }
                        step="any"
                        defaultValue={value === undefined ? '' : String(value)}
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
            {editable ? (
              <div>
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save profile'}
                </Button>
              </div>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Consent{' '}
            <Badge variant={consentLabel[contact.consentStatus].variant}>
              {consentLabel[contact.consentStatus].label}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {editable ? (
            <form onSubmit={submitConsent} className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="consent">Status</Label>
                <NativeSelect
                  id="consent"
                  className="w-40"
                  value={consent}
                  onChange={(e) => setConsent(e.target.value as ConsentStatusValue)}
                >
                  <option value="OPTED_IN">Opted in</option>
                  <option value="UNKNOWN">Unknown</option>
                  <option value="OPTED_OUT">Opted out</option>
                </NativeSelect>
              </div>
              <div className="grid min-w-64 flex-1 gap-1.5">
                <Label htmlFor="consent-note">
                  Source note {consent === 'OPTED_IN' ? '(required for opt-in)' : '(optional)'}
                </Label>
                <Input
                  id="consent-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder="Customer asked in store on 12 Nov"
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                disabled={consent === contact.consentStatus || save.isPending}
              >
                Update consent
              </Button>
            </form>
          ) : null}
          <div className="grid gap-2">
            <div className="text-sm font-medium">History</div>
            {!contact.consentHistory.length ? (
              <p className="text-sm text-muted-foreground">No consent changes recorded yet.</p>
            ) : null}
            <ol className="grid gap-2">
              {contact.consentHistory.map((h) => (
                <li key={`${h.createdAt}-${h.status}`} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={consentLabel[h.status].variant}>
                      {consentLabel[h.status].label}
                    </Badge>
                    <span className="text-muted-foreground">
                      {titleCase(h.source)} · {formatDateTime(h.createdAt)}
                    </span>
                  </div>
                  {h.note ? <div className="mt-1">{h.note}</div> : null}
                </li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
