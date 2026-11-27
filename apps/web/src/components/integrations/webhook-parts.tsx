'use client';

import { EVENT_GROUPS, EVENT_LABELS, SUBSCRIBABLE_EVENT_TYPES, type EventType } from '@wbm/shared';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import type { WebhookEndpointStatus } from '@/lib/integrations';
import { Badge } from '@/components/ui/badge';
import { ENDPOINT_STATUS_LABEL } from '@/lib/integrations';

// Shared parts of the webhook pages (feature 006 US1, T025): the event picker grouped like the
// catalog, the secret shown once, and the endpoint status badge. Our own wording.

const GROUP_LABEL: Record<string, string> = {
  messages: 'Messages',
  contacts: 'Contacts',
  links: 'Tracked links',
  drips: 'Drips',
  live_chat: 'Live chat',
  api_campaigns: 'API campaigns',
  stores: 'Stores',
  ads: 'Ads',
  payments: 'Payments',
  commerce: 'Chat orders',
  forms: 'WhatsApp Forms',
};

const GROUPS = Object.keys(GROUP_LABEL).map((group) => ({ group, types: SUBSCRIBABLE_EVENT_TYPES.filter((t) => EVENT_GROUPS[t] === group) })).filter((g) => g.types.length > 0);

export function EventPicker({ value, onChange, disabled }: { value: EventType[]; onChange: (next: EventType[]) => void; disabled?: boolean }) {
  const chosen = new Set(value);
  const toggle = (type: EventType, on: boolean) => onChange(SUBSCRIBABLE_EVENT_TYPES.filter((t) => (t === type ? on : chosen.has(t))));
  return (
    <fieldset className="grid gap-3" disabled={disabled}>
      <legend className="text-sm font-medium">Events</legend>
      {GROUPS.map(({ group, types }) => (
        <div key={group} className="grid gap-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{GROUP_LABEL[group]}</div>
          {types.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={chosen.has(type)} onChange={(e) => toggle(type, e.target.checked)} />
              <span>{EVENT_LABELS[type]}</span>
              <code className="text-xs text-muted-foreground">{type}</code>
            </label>
          ))}
        </div>
      ))}
    </fieldset>
  );
}

export function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="grid gap-3">
      <Label htmlFor="webhook-secret">Signing secret</Label>
      <div className="flex gap-2">
        <Input id="webhook-secret" readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(secret)
              .then(() => toast.success('Secret copied'))
              .catch(() => toast.error('Copy failed; select the secret and copy it'))
          }
        >
          Copy
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Your receiver checks each event&apos;s <code>webhook-signature</code> with this secret. It is shown only once; you can make a new one later.
      </p>
      <DialogFooter>
        <Button onClick={onDone}>I have stored it</Button>
      </DialogFooter>
    </div>
  );
}

export function EndpointStatusBadge({ status }: { status: WebhookEndpointStatus }) {
  const variant = status === 'ACTIVE' ? 'success' : status === 'FAILING' ? 'destructive' : 'warning';
  return (
    <Badge variant={variant} data-testid="endpoint-status">
      {ENDPOINT_STATUS_LABEL[status]}
    </Badge>
  );
}
