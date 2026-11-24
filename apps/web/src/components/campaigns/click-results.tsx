'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { destinationProblem } from '@wbm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toaster';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import { growthKeys, type ClickSummary, type Clicker, type TrackedLinkConfig, type TrackedLinkTarget } from '@/lib/growth';
import { Can } from '@/lib/permissions';

const PAGE_SIZE = 50;
const percent = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Tracked-link results of a campaign (feature 005 US1, FR-006, FR-008): clickers, clicks per link and the Clicked view. */
export function ClickResults({ campaignId }: { campaignId: string }) {
  const summary = useQuery({ queryKey: growthKeys.clickSummary(campaignId), queryFn: () => api<ClickSummary>(`/campaigns/${campaignId}/clicks/summary`) });
  const [page, setPage] = useState(1);
  const clickers = useQuery({
    queryKey: growthKeys.clickers(campaignId, page),
    queryFn: () => api<{ items: Clicker[]; total: number }>(`/campaigns/${campaignId}/clicks?page=${page}&pageSize=${PAGE_SIZE}`),
    enabled: Boolean(summary.data?.links.length),
  });
  const [editing, setEditing] = useState<ClickSummary['links'][number] | null>(null);

  if (summary.isLoading) return null;
  if (summary.error) return <p className="text-sm text-destructive">{errorMessage(summary.error)}</p>;
  const s = summary.data;
  if (!s?.links.length) return null;
  const pages = Math.max(1, Math.ceil((clickers.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link clicks</CardTitle>
        <CardDescription>Clicks on the tracked links of this campaign. Link previews and robots are not counted.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-muted-foreground">People who clicked</div>
            <div className="text-2xl font-semibold" data-testid="clickers-count">
              {formatNumber(s.clickers)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Clicks</div>
            <div className="text-2xl font-semibold" data-testid="clicks-count">
              {formatNumber(s.clicks)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Click rate (of delivered)</div>
            <div className="text-2xl font-semibold" data-testid="click-rate">
              {percent(s.clickRate)}
            </div>
          </div>
        </div>

        <Tabs defaultValue="links">
          <TabsList>
            <TabsTrigger value="links">Links</TabsTrigger>
            <TabsTrigger value="clicked">Clicked</TabsTrigger>
          </TabsList>
          <TabsContent value="links">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variable</TableHead>
                  <TableHead>Goes to</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.links.map((l) => (
                  <TableRow key={l.targetId} data-testid="link-row">
                    <TableCell className="font-mono text-xs">{l.variableKey}</TableCell>
                    <TableCell className="max-w-xs truncate" title={l.destination}>
                      {l.destination}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(l.clickers)}</TableCell>
                    <TableCell className="text-right">{formatNumber(l.clicks)}</TableCell>
                    <TableCell className="text-right">
                      <Can permission="campaigns.manage">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(l)}>
                          Change
                        </Button>
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="clicked" className="grid gap-3">
            <div className="flex justify-end">
              <Can permission="data.export">
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/campaigns/${campaignId}/clicks/export`} download>
                    Export clicked (CSV)
                  </a>
                </Button>
              </Can>
            </div>
            {clickers.data?.items.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead>First click</TableHead>
                    <TableHead>Last click</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clickers.data.items.map((c, i) => (
                    <TableRow key={c.contactId ?? `row-${i}`} data-testid="clicker-row">
                      <TableCell>{c.name ?? 'Deleted contact'}</TableCell>
                      <TableCell className="text-muted-foreground">{c.phone ?? '—'}</TableCell>
                      <TableCell className="text-right">{formatNumber(c.clicks)}</TableCell>
                      <TableCell>{formatDateTime(c.firstClickAt)}</TableCell>
                      <TableCell>{formatDateTime(c.lastClickAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">{clickers.isLoading ? 'Loading…' : 'Nobody has clicked yet.'}</p>
            )}
            {pages > 1 ? (
              <div className="flex items-center gap-2 text-sm">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span>
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </CardContent>
      {editing ? <DestinationDialog campaignId={campaignId} link={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

/** Changes where a tracked link goes, also while the campaign runs (FR-006). New clicks go to the new address. */
function DestinationDialog({ campaignId, link, onClose }: { campaignId: string; link: ClickSummary['links'][number]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: growthKeys.linkConfig, queryFn: () => api<TrackedLinkConfig>('/tracked-links/config'), staleTime: 5 * 60_000 });
  const [destination, setDestination] = useState(link.destination);
  const problem = destinationProblem(destination, config.data?.baseUrl ?? undefined);
  const save = useMutation({
    mutationFn: () => api<TrackedLinkTarget>(`/tracked-link-targets/${link.targetId}`, { method: 'PATCH', json: { destination: destination.trim() } }),
    onSuccess: async () => {
      toast.success('Destination changed. New clicks go to the new address.');
      await queryClient.invalidateQueries({ queryKey: growthKeys.clickSummary(campaignId) });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change where the link goes</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="link-destination">Destination address</Label>
          <Input id="link-destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
          {problem ? <p className="text-xs text-destructive">Enter a full address starting with https://</p> : null}
          {!problem && destination.trim().startsWith('http://') ? <p className="text-xs text-amber-700">This address is not secure (http). Use https:// if the site supports it.</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={Boolean(problem) || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
