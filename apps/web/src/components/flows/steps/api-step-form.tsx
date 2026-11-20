'use client';

import { useMutation } from '@tanstack/react-query';
import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { toastError } from '@/lib/errors';
import type { FlowSecret } from '../secrets-panel';
import { cleanAnswerName, TEXTAREA_CLASS } from './form-bits';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type ApiStep = StepOf<'api'>;
type NameValue = ApiStep['headers'][number];

interface TestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  body?: unknown;
  mapped?: Record<string, unknown>;
  error: string | null;
}

const ERRORS: Record<string, string> = {
  BLOCKED_ADDRESS: 'Blocked address: private and reserved addresses cannot be called.',
  NOT_HTTPS: 'Only https:// addresses can be called.',
  BAD_URL: 'The address is not a valid URL.',
  TIMEOUT: 'No reply within the timeout.',
  TOO_LARGE: 'The reply is larger than 100 KB.',
  NOT_JSON: 'The reply is not JSON.',
  REDIRECT: 'The address answered with a redirect, which flows do not follow.',
  NETWORK: 'The address could not be reached.',
};

/** Leaf paths of a JSON reply (`order.status`, `items.0.name`), for picking what to map. */
function leafPaths(value: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= 40 || depth > 5) return out;
  if (Array.isArray(value)) value.slice(0, 5).forEach((item, i) => leafPaths(item, prefix ? `${prefix}.${i}` : String(i), depth + 1, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) leafPaths(item, prefix ? `${prefix}.${key}` : key, depth + 1, out);
  else if (prefix) out.push(prefix);
  return out;
}

const answerNameFor = (path: string) => cleanAnswerName(path.split('.').filter((p) => !/^\d+$/.test(p)).at(-1) ?? 'value') ?? 'value';

/** API step (FR-014): an HTTPS request with variables and secrets, reply fields mapped into answers. */
export function ApiStepForm({ step, graph, flowId, secrets, onPatch }: { step: ApiStep; graph: FlowGraph; flowId: string; secrets: FlowSecret[]; onPatch: StepPatch<ApiStep> }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const answersUsed = [...new Set([...`${step.url} ${step.body ?? ''} ${step.query.map((q) => q.value).join(' ')} ${step.headers.map((h) => h.value).join(' ')}`.matchAll(/\{answer:([a-z][a-z0-9_]{0,39})\}/g)].map((m) => m[1]!))];
  const test = useMutation({
    mutationFn: () => api<TestResult>(`/flows/${flowId}/api-test`, { method: 'POST', json: { step, answers: samples } }),
    onSuccess: setResult,
    onError: toastError,
  });

  const setList = (list: 'headers' | 'query', items: NameValue[], key?: string) => onPatch(list === 'headers' ? { headers: items } : { query: items }, key);
  const nameValueRows = (list: 'headers' | 'query', label: string, max: number) => (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {step[list].map((item, index) => (
        <div key={index} className="grid gap-1 rounded-md border p-2">
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label={`${label} ${index + 1} name`} value={item.name} maxLength={100} placeholder="Name" onChange={(e) => setList(list, step[list].map((it, i) => (i === index ? { ...it, name: e.target.value } : it)), `${list}:${index}:name`)} />
            <Input aria-label={`${label} ${index + 1} value`} value={item.value} maxLength={2000} placeholder="Value" onChange={(e) => setList(list, step[list].map((it, i) => (i === index ? { ...it, value: e.target.value } : it)), `${list}:${index}:value`)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {list === 'headers' && secrets.length > 0 && (
              <NativeSelect
                aria-label={`Insert a secret into header ${index + 1}`}
                className="h-8 w-auto"
                value=""
                onChange={(e) => {
                  if (e.target.value) setList(list, step[list].map((it, i) => (i === index ? { ...it, value: `${it.value}{secret:${e.target.value}}` } : it)));
                }}
              >
                <option value="">Insert a secret…</option>
                {secrets.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setList(list, step[list].filter((_, i) => i !== index))}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      {step[list].length < max && (
        <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setList(list, [...step[list], { name: list === 'headers' ? 'Authorization' : 'param', value: '' }])}>
          {list === 'headers' ? 'Add header' : 'Add query value'}
        </Button>
      )}
    </fieldset>
  );

  const secretName = (id: string) => secrets.find((s) => s.id === id)?.name ?? 'a deleted secret';

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[6rem_1fr] gap-2">
        <div className="grid gap-1">
          <Label htmlFor="api-method">Method</Label>
          <NativeSelect id="api-method" value={step.method} onChange={(e) => onPatch({ method: e.target.value as ApiStep['method'] })}>
            {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="api-url">Address</Label>
          <Input id="api-url" value={step.url} maxLength={2048} placeholder="https://api.example.com/orders/{answer:order}" onChange={(e) => onPatch({ url: e.target.value }, 'url')} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Only public https:// addresses. Variables such as {'{answer:order}'} are filled in and encoded.</p>
      {nameValueRows('headers', 'Header', FLOW_LIMITS.apiHeaders)}
      {step.headers.some((h) => /\{secret:/.test(h.value)) && (
        <p className="text-xs text-muted-foreground">
          Secrets used: {[...new Set(step.headers.flatMap((h) => [...h.value.matchAll(/\{secret:([0-9a-f-]{36})\}/g)].map((m) => m[1]!)))].map(secretName).join(', ')} (shown as •••• when sent).
        </p>
      )}
      {nameValueRows('query', 'Query value', FLOW_LIMITS.apiQuery)}
      {(step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH') && (
        <div className="grid gap-1">
          <Label htmlFor="api-body">JSON body</Label>
          <textarea id="api-body" className={`${TEXTAREA_CLASS} font-mono`} value={step.body ?? ''} maxLength={FLOW_LIMITS.apiBodyLength} placeholder={'{"order": "{answer:order}"}'} onChange={(e) => onPatch({ body: e.target.value || undefined }, 'body')} />
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor="api-timeout">Give up after (seconds)</Label>
        <Input
          id="api-timeout"
          type="number"
          min={FLOW_LIMITS.apiTimeoutMin}
          max={FLOW_LIMITS.apiTimeoutMax}
          value={step.timeoutSeconds}
          onChange={(e) => {
            const seconds = Number(e.target.value);
            if (Number.isInteger(seconds) && seconds >= FLOW_LIMITS.apiTimeoutMin && seconds <= FLOW_LIMITS.apiTimeoutMax) onPatch({ timeoutSeconds: seconds }, 'timeout');
          }}
        />
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Save reply fields as answers</legend>
        {step.map.map((item, index) => (
          <div key={index} className="flex items-end gap-2">
            <Input aria-label={`Reply field ${index + 1}`} value={item.path} maxLength={200} placeholder="order.status" onChange={(e) => onPatch({ map: step.map.map((m, i) => (i === index ? { ...m, path: e.target.value } : m)) }, `map:${index}:path`)} />
            <Input
              aria-label={`Answer name ${index + 1}`}
              value={item.answerName}
              maxLength={40}
              onChange={(e) => onPatch({ map: step.map.map((m, i) => (i === index ? { ...m, answerName: cleanAnswerName(e.target.value) ?? 'value' } : m)) }, `map:${index}:name`)}
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => onPatch({ map: step.map.filter((_, i) => i !== index) })}>
              Remove
            </Button>
          </div>
        ))}
        {step.map.length < FLOW_LIMITS.apiMap && (
          <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => onPatch({ map: [...step.map, { path: 'status', answerName: 'status' }] })}>
            Add reply field
          </Button>
        )}
      </fieldset>

      <section aria-labelledby="api-test-title" className="grid gap-2 rounded-md border p-2">
        <h3 id="api-test-title" className="text-sm font-medium">
          Test request
        </h3>
        {answersUsed.map((name) => (
          <div key={name} className="grid gap-1">
            <Label htmlFor={`sample-${name}`} className="text-xs font-normal">
              Sample value for {`{answer:${name}}`}
            </Label>
            <Input id={`sample-${name}`} value={samples[name] ?? ''} maxLength={1000} onChange={(e) => setSamples({ ...samples, [name]: e.target.value })} />
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => test.mutate()} disabled={!step.url.trim() || test.isPending}>
          {test.isPending ? 'Calling…' : 'Send test request'}
        </Button>
        {result && (
          <div className="grid gap-1 text-xs" data-testid="api-test-result" role="status">
            <p className={result.ok ? 'text-success' : 'text-destructive'}>
              {result.error ? (ERRORS[result.error] ?? result.error) : `Status ${result.status} in ${result.durationMs} ms${result.ok ? '' : ' (the failed branch would run)'}`}
            </p>
            {result.body !== undefined && result.body !== null && (
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2">{typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}</pre>
            )}
            {result.ok &&
              leafPaths(result.body)
                .filter((path) => !step.map.some((m) => m.path === path))
                .slice(0, 12)
                .map((path) => (
                  <Button
                    key={path}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="justify-self-start"
                    disabled={step.map.length >= FLOW_LIMITS.apiMap}
                    onClick={() => onPatch({ map: [...step.map, { path, answerName: answerNameFor(path) }] })}
                  >
                    Save {path} as an answer
                  </Button>
                ))}
          </div>
        )}
      </section>

      <GoesToSelect id="api-success" label="If the call works, go to" graph={graph} fromId={step.id} value={step.success} required onChange={(success) => onPatch({ success })} />
      <GoesToSelect id="api-failed" label="If the call fails, go to" graph={graph} fromId={step.id} value={step.failed} required onChange={(failed) => onPatch({ failed })} />
    </div>
  );
}
