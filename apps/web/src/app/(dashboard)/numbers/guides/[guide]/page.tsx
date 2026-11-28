'use client';

import { NUMBER_GUIDES } from '@wbm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { RequirePermission } from '@/components/require-permission';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Feature 010 (US8, FR-034): moving a number to this platform and back to the WhatsApp Business app, from the
// shared guide data (checked against Meta's pages on `checkedAt`).

export default function NumberGuidePage() {
  return (
    <RequirePermission permission="numbers.view">
      <Guide />
    </RequirePermission>
  );
}

function Guide() {
  const { guide } = useParams<{ guide: string }>();
  const data = NUMBER_GUIDES.find((g) => g.id === guide);
  if (!data) return <p className="text-sm text-destructive">This guide does not exist.</p>;
  return (
    <div className="grid max-w-3xl gap-6">
      <Link href="/settings/numbers" className="text-sm text-muted-foreground hover:underline">
        ← WhatsApp numbers
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{data.title}</h1>
        <p className="text-sm text-muted-foreground">{data.intro}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steps</CardTitle>
          <CardDescription>Checked against Meta&apos;s pages on {data.checkedAt}.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-4">
            {data.steps.map((step, i) => (
              <li key={step.title} className="grid gap-1 text-sm" data-testid="guide-step">
                <span className="font-medium">
                  {i + 1}. {step.title}
                </span>
                <span className="text-muted-foreground">{step.body}</span>
                {step.warning ? (
                  <span role="note" className="rounded-md border border-warning/60 bg-warning/10 px-2 py-1 text-xs" data-testid="guide-warning">
                    {step.warning}
                  </span>
                ) : null}
                {data.id === 'move-back' && step.title.startsWith('Remove the number') ? (
                  <Link href="/settings/numbers" className="text-xs underline">
                    Open WhatsApp numbers to remove it
                  </Link>
                ) : null}
                {data.id === 'move-here' && step.title.startsWith('Connect the number') ? (
                  <Link href="/numbers/connect" className="text-xs underline">
                    Open the connection wizard
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meta&apos;s pages</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {data.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="underline">
              {l.label}
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
