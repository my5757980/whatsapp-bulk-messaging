'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adsKeys, money, type AdResultNumbers, type AdResults } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { formatDateTime, formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';

function Tile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(2)}%`);

/** Meta's numbers and the platform's own per day and per version (feature 007 US4, FR-026 – FR-029). */
export function AdResultsPanel({ campaignId, versions }: { campaignId: string; versions: Array<{ id: string; position: number }> }) {
  const results = useQuery({ queryKey: adsKeys.results(campaignId), queryFn: () => api<AdResults>(`/ads/campaigns/${campaignId}/results`), refetchInterval: 60_000 });
  const r = results.data;
  if (results.isLoading) return <p className="text-sm text-muted-foreground">Loading results…</p>;
  if (!r) return <p className="text-sm text-muted-foreground">No results yet.</p>;
  const m = (n: number | null | undefined) => money(n ?? null, r.currency);
  const t: AdResultNumbers = r.totals;
  const position = new Map(versions.map((v) => [v.id, v.position]));

  return (
    <div className="grid gap-4" data-testid="ad-results">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Spent" value={m(t.spendMinor)} testId="ad-result-spend" />
        <Tile label="Impressions" value={formatNumber(t.impressions)} testId="ad-result-impressions" />
        <Tile label="Clicks (CTR)" value={`${formatNumber(t.clicks)} (${pct(t.ctr)})`} testId="ad-result-clicks" />
        <Tile label="Meta's conversations" value={formatNumber(t.metaConversations ?? 0)} testId="ad-result-meta-conversations" />
        <Tile label="Chats started" value={formatNumber(t.chatsStarted)} testId="ad-result-chats" />
        <Tile label="New contacts" value={formatNumber(t.newContacts)} testId="ad-result-new-contacts" />
        <Tile label="Replied after our answer" value={formatNumber(t.replied)} testId="ad-result-replied" />
        <Tile label="Cost per chat" value={m(t.costPerChatMinor)} testId="ad-result-cost-per-chat" />
        {t.leads ? <Tile label="Leads (cost per lead)" value={`${formatNumber(t.leads)} (${m(t.costPerLeadMinor)})`} testId="ad-result-leads" /> : null}
        {t.visits ? <Tile label="Website visits" value={formatNumber(t.visits)} testId="ad-result-visits" /> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Meta&apos;s numbers update every hour ({r.syncedAt ? `last read ${formatDateTime(r.syncedAt)}` : 'not read yet'}); days follow {r.timezone}. Reach over several days cannot be added up, so the
        total shows the highest day.
      </p>
      {r.days.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Reach</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Chats</TableHead>
              <TableHead className="text-right">Cost per chat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...r.days].reverse().map((d) => (
              <TableRow key={d.date}>
                <TableCell>{d.date}</TableCell>
                <TableCell className="text-right">{m(d.spendMinor)}</TableCell>
                <TableCell className="text-right">{formatNumber(d.impressions)}</TableCell>
                <TableCell className="text-right">{formatNumber(d.reach)}</TableCell>
                <TableCell className="text-right">{formatNumber(d.clicks)}</TableCell>
                <TableCell className="text-right">{formatNumber(d.chatsStarted)}</TableCell>
                <TableCell className="text-right">{m(d.costPerChatMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">Meta has no numbers for this campaign yet.</p>
      )}
      {r.versions.length > 1 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Impressions</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Chats</TableHead>
              <TableHead className="text-right">Cost per chat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.versions.map((v) => (
              <TableRow key={v.versionId}>
                <TableCell>Version {position.get(v.versionId) ?? '?'}</TableCell>
                <TableCell className="text-right">{m(v.spendMinor)}</TableCell>
                <TableCell className="text-right">{formatNumber(v.impressions)}</TableCell>
                <TableCell className="text-right">{formatNumber(v.clicks)}</TableCell>
                <TableCell className="text-right">{formatNumber(v.chatsStarted)}</TableCell>
                <TableCell className="text-right">{m(v.costPerChatMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <Can permission="data.export">
        <Button asChild variant="outline" className="justify-self-start">
          <a href={`/api/ads/campaigns/${campaignId}/results/export`} download>
            Export CSV
          </a>
        </Button>
      </Can>
    </div>
  );
}
