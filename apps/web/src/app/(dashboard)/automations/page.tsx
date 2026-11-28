'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { RequirePermission } from '@/components/require-permission';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { AUTOMATION_STATUS_LABEL, AUTOMATION_STATUS_VARIANT, automationKeys, offsetText, type DateAutomation } from '@/lib/automations';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { Can } from '@/lib/permissions';

/** Date automations (feature 010 US5): birthdays, anniversaries and renewals from contact date attributes. */
export default function AutomationsPage() {
  return (
    <RequirePermission permission="campaigns.view">
      <AutomationList />
    </RequirePermission>
  );
}

function AutomationList() {
  const automations = useQuery({ queryKey: automationKeys.list, queryFn: () => api<{ items: DateAutomation[] }>('/date-automations') });
  const items = automations.data?.items ?? [];
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Automations</h1>
          <p className="text-sm text-muted-foreground">
            Templates sent on dates stored in contact attributes, such as birthdays or renewals. Each contact gets one message per date.
          </p>
        </div>
        <Can permission="campaigns.manage">
          <Button asChild>
            <Link href="/automations/new">New automation</Link>
          </Button>
        </Can>
      </div>
      <Card>
        <CardContent className="p-0">
          {automations.error ? (
            <p className="p-6 text-sm text-destructive">{errorMessage(automations.error)}</p>
          ) : items.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead className="text-right">Sent (7 days)</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((a) => (
                  <TableRow key={a.id} data-testid="automation-row">
                    <TableCell>
                      <Link href={`/automations/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={AUTOMATION_STATUS_VARIANT[a.status]}>{AUTOMATION_STATUS_LABEL[a.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.timing === 'YEARLY' ? 'Every year' : 'Once'}, {offsetText(a.offsetDays)} in {a.attributeKey} at {a.sendTime}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.templateName}</TableCell>
                    <TableCell className="text-right">{formatNumber(a.last7Days.sent)}</TableCell>
                    <TableCell className="text-right">{formatNumber(a.last7Days.failed)}</TableCell>
                    <TableCell className="text-right">{formatNumber(a.last7Days.skipped)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{automations.isLoading ? 'Loading…' : 'No automations yet. Create one to greet contacts on their birthday.'}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
