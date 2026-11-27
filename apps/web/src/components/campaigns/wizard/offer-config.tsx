'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import type { CampaignOfferConfig } from '@/lib/types';

/** A new offer: ends in two days, one code for everyone (feature 009, research R7). */
export function defaultOfferConfig(now = Date.now()): CampaignOfferConfig {
  return { endsAt: new Date(now + 2 * 86_400_000).toISOString(), code: { source: 'static', value: '' } };
}

export function offerConfigComplete(config: CampaignOfferConfig | null, now = Date.now()): boolean {
  if (!config) return false;
  const ends = Date.parse(config.endsAt);
  const code = config.code.source === 'static' ? (config.code.value ?? '').trim() : (config.code.key ?? '').trim();
  return Number.isFinite(ends) && ends > now && code.length > 0 && (config.code.source !== 'static' || code.length <= 15);
}

/** A local date and time for the input (no seconds). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line for the review step. */
export function offerConfigSummary(config: CampaignOfferConfig): string {
  const code = config.code.source === 'static' ? `the code ${config.code.value}` : config.code.source === 'column' ? `codes from the “${config.code.key}” column` : `codes from the ${config.code.key} attribute`;
  return `The offer ends ${new Date(config.endsAt).toLocaleString()}; recipients get ${code}. Nothing is sent after the end.`;
}

/**
 * When a limited-time offer ends and where each recipient's code comes from (feature 009 US3, FR-010):
 * one code for everyone, an uploaded column or a contact attribute. Recipients without a code are skipped.
 */
export function OfferConfigCard({ value, onChange, columns }: { value: CampaignOfferConfig; onChange: (next: CampaignOfferConfig) => void; columns: string[] }) {
  const ends = Date.parse(value.endsAt);
  const code = value.code;
  return (
    <section aria-labelledby="offer-config-title" className="grid gap-3 rounded-md border p-4" data-testid="offer-config">
      <div>
        <h3 id="offer-config-title" className="text-sm font-medium">
          Limited-time offer
        </h3>
        <p className="text-xs text-muted-foreground">The message counts down to the end. Messages not sent by then are dropped as “offer ended”.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="offer-ends">Offer ends</Label>
          <Input
            id="offer-ends"
            type="datetime-local"
            value={toLocalInput(value.endsAt)}
            onChange={(e) => {
              const next = new Date(e.target.value);
              if (!Number.isNaN(next.getTime())) onChange({ ...value, endsAt: next.toISOString() });
            }}
          />
          {Number.isFinite(ends) && ends <= Date.now() ? <p className="text-xs text-destructive">Choose a time in the future.</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="offer-code-source">Code</Label>
          <NativeSelect id="offer-code-source" value={code.source} onChange={(e) => onChange({ ...value, code: { source: e.target.value as CampaignOfferConfig['code']['source'], ...(e.target.value === 'static' ? { value: '' } : { key: '' }) } })}>
            <option value="static">The same code for everyone</option>
            <option value="column">From an uploaded column</option>
            <option value="attribute">From a contact attribute</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="offer-code-value">{code.source === 'static' ? 'Code (up to 15 characters)' : code.source === 'column' ? 'Column' : 'Attribute key'}</Label>
          {code.source === 'static' ? (
            <Input id="offer-code-value" maxLength={15} value={code.value ?? ''} placeholder="WKND20" onChange={(e) => onChange({ ...value, code: { source: 'static', value: e.target.value.trim() } })} />
          ) : code.source === 'column' && columns.length ? (
            <NativeSelect id="offer-code-value" value={code.key ?? ''} onChange={(e) => onChange({ ...value, code: { source: 'column', key: e.target.value } })}>
              <option value="">Choose a column…</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input id="offer-code-value" value={code.key ?? ''} placeholder={code.source === 'column' ? 'code' : 'offer_code'} onChange={(e) => onChange({ ...value, code: { source: code.source, key: e.target.value.trim() } })} />
          )}
        </div>
      </div>
      {code.source !== 'static' ? <p className="text-xs text-muted-foreground">Recipients without a code are skipped as “missing offer code”. Codes longer than 15 characters are cut.</p> : null}
    </section>
  );
}
