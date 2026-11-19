'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { ApiError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { usePermissions } from '@/lib/permissions';

interface RateRow {
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | 'SERVICE';
  countryCode: string;
  priceUsd: number | string;
  effectiveFrom: string;
}

const CATEGORIES: RateRow['category'][] = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE'];
const today = () => new Date().toISOString().slice(0, 10);

/** Settings > Rate card (T165, FR-029): USD price per category and country, with effective dates. */
export default function RateCardPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('ratecard.manage');
  const rates = useQuery({ queryKey: ['rate-card'], queryFn: () => api<RateRow[]>('/rate-card') });
  const [rows, setRows] = useState<RateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (rates.data) setRows(rates.data);
  }, [rates.data]);

  const save = useMutation({
    mutationFn: () => api<RateRow[]>('/rate-card', { method: 'PUT', json: rows.map((r) => ({ ...r, priceUsd: Number(r.priceUsd) })) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['rate-card'], saved);
      setRowErrors({});
      toast.success('Rate card saved');
    },
    onError: (e) => {
      setError(errorMessage(e));
      if (e instanceof ApiError) setRowErrors(Object.fromEntries((e.details ?? []).map((d) => [d.field.split('.')[0] ?? d.field, d.issue])));
    },
  });

  const set = (i: number, patch: Partial<RateRow>) => setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle className="text-base">Rate card (USD)</CardTitle>
        <CardDescription>
          Price per delivered message by category and recipient country. Use * as the country for the default price. Reports and pre-launch estimates use
          the rate effective on the delivery date; they are estimates, not invoices.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Price (USD)</TableHead>
              <TableHead>Effective from</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} data-testid="rate-row">
                <TableCell>
                  <NativeSelect aria-label={`Row ${i + 1} category`} value={r.category} disabled={!editable} onChange={(e) => set(i, { category: e.target.value as RateRow['category'] })}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0) + c.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
                <TableCell>
                  <Input aria-label={`Row ${i + 1} country`} className="w-20" value={r.countryCode} disabled={!editable} maxLength={2} onChange={(e) => set(i, { countryCode: e.target.value.toUpperCase() })} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Row ${i + 1} price`} className="w-32" type="number" min={0} step="0.0001" value={r.priceUsd} disabled={!editable} onChange={(e) => set(i, { priceUsd: e.target.value })} />
                </TableCell>
                <TableCell>
                  <Input aria-label={`Row ${i + 1} effective from`} type="date" value={r.effectiveFrom} disabled={!editable} onChange={(e) => set(i, { effectiveFrom: e.target.value })} />
                  {rowErrors[String(i)] ? <p className="text-xs text-destructive">{rowErrors[String(i)]}</p> : null}
                </TableCell>
                <TableCell className="text-right">
                  {editable ? (
                    <Button variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rates.isSuccess && !rows.length ? <p className="text-sm text-muted-foreground">No rates yet; cost estimates show $0 until you add some.</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {editable ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setRows((current) => [...current, { category: 'MARKETING', countryCode: '*', priceUsd: '', effectiveFrom: today() }])}>
              Add rate
            </Button>
            <Button
              onClick={() => {
                setError(null);
                save.mutate();
              }}
              disabled={save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save rate card'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
