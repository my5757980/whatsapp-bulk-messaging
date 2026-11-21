'use client';

import { useMutation } from '@tanstack/react-query';
import { AI_LIMITS, ApiSkillSchema, type AgentProblem, type ApiSkill } from '@wbm/shared';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { toast } from '@/components/ui/toaster';
import { api, ApiError } from '@/lib/api-client';
import { toastError } from '@/lib/errors';

export interface AgentSecret {
  id: string;
  name: string;
  updatedAt: string;
}

interface SkillTestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  body?: unknown;
  mapped?: Record<string, unknown>;
  error: string | null;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Lower-case letters, digits and _, starting with a letter (the config's rule for ids and keys). */
const cleanKey = (value: string, max = 40) => value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, max);

function newSkillId(taken: string[]): string {
  for (let n = 1; ; n += 1) {
    const id = `skill_${n}`;
    if (!taken.includes(id)) return id;
  }
}

function Problems({ problems, prefix }: { problems: AgentProblem[]; prefix: string }) {
  const mine = problems.filter((p) => p.field === prefix || p.field?.startsWith(`${prefix}.`) || p.field?.startsWith(`${prefix}[`));
  if (!mine.length) return null;
  return (
    <ul className="grid gap-0.5">
      {mine.map((p, i) => (
        <li key={`${p.code}:${i}`} className="text-xs text-destructive">
          {p.message}
        </li>
      ))}
    </ul>
  );
}

interface ApiSkillsProps {
  agentId: string;
  skills: ApiSkill[];
  secrets: AgentSecret[];
  problems: AgentProblem[];
  onChange: (skills: ApiSkill[]) => void;
  onSecretsChange: (secrets: AgentSecret[]) => void;
}

/**
 * API skills (004 T076, FR-030, FR-031): calls to the company's systems the agent may make, with the
 * inputs it asks the customer for, the request (secrets only in headers), the reply fields it may use,
 * "changes data" for calls that need the customer's confirmation, and a test request.
 */
export function ApiSkills({ agentId, skills, secrets, problems, onChange, onSecretsChange }: ApiSkillsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const update = (index: number, next: ApiSkill) => onChange(skills.map((s, i) => (i === index ? next : s)));

  return (
    <section className="grid gap-3" aria-labelledby="api-skills-title">
      <div>
        <h2 id="api-skills-title" className="text-base font-semibold">
          Company systems
        </h2>
        <p className="text-sm text-muted-foreground">
          Let the agent look things up, such as an order&apos;s status. It asks the customer for the inputs, and sees only the reply fields you map. Calls that change data need the customer&apos;s confirmation first.
        </p>
      </div>
      {skills.map((skill, i) => (
        <div key={skill.id} className="grid gap-2 rounded-md border p-3" data-testid="api-skill">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{skill.name}</span>
              {skill.changesData && <Badge variant="warning">Changes data</Badge>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(open === skill.id ? null : skill.id)}>
                {open === skill.id ? 'Close' : 'Edit'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onChange(skills.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          </div>
          <Problems problems={problems} prefix={`skills.api[${i}]`} />
          {open === skill.id && <SkillEditor agentId={agentId} skill={skill} secrets={secrets} onChange={(next) => update(i, next)} />}
        </div>
      ))}
      {skills.length < AI_LIMITS.apiSkills && (
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const skill = ApiSkillSchema.parse({ id: newSkillId(skills.map((s) => s.id)), name: 'New skill', request: {} });
              onChange([...skills, skill]);
              setOpen(skill.id);
            }}
          >
            Add a skill
          </Button>
        </div>
      )}
      <SecretsPanel agentId={agentId} secrets={secrets} onChange={onSecretsChange} />
    </section>
  );
}

function SkillEditor({ agentId, skill, secrets, onChange }: { agentId: string; skill: ApiSkill; secrets: AgentSecret[]; onChange: (skill: ApiSkill) => void }) {
  const set = (patch: Partial<ApiSkill>) => onChange({ ...skill, ...patch });
  const setRequest = (patch: Partial<ApiSkill['request']>) => set({ request: { ...skill.request, ...patch } });
  const hasBody = skill.request.method === 'POST' || skill.request.method === 'PUT' || skill.request.method === 'PATCH';

  return (
    <div className="grid gap-4 border-t pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={`skill-name-${skill.id}`}>Skill name</Label>
          <Input id={`skill-name-${skill.id}`} value={skill.name} maxLength={AI_LIMITS.apiSkillName} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`skill-id-${skill.id}`}>Id</Label>
          <Input id={`skill-id-${skill.id}`} value={skill.id} readOnly className="bg-muted" />
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`skill-when-${skill.id}`}>When to use it</Label>
        <textarea
          id={`skill-when-${skill.id}`}
          className={TEXTAREA_CLASS}
          value={skill.whenToUse}
          maxLength={AI_LIMITS.whenToUse}
          placeholder="When the customer asks where their order is."
          onChange={(e) => set({ whenToUse: e.target.value })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={skill.changesData} onChange={(e) => set({ changesData: e.target.checked })} />
        Changes data (the agent asks the customer to confirm before calling it)
      </label>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Inputs the agent asks for</legend>
        {skill.inputs.map((input, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto_auto] sm:items-center">
            <Input
              aria-label={`Input ${i + 1} key`}
              value={input.key}
              placeholder="order_number"
              onChange={(e) => set({ inputs: skill.inputs.map((x, j) => (j === i ? { ...x, key: cleanKey(e.target.value) } : x)) })}
            />
            <Input
              aria-label={`Input ${i + 1} description`}
              value={input.description}
              maxLength={AI_LIMITS.inputDescription}
              placeholder="The order number, for example 10234"
              onChange={(e) => set({ inputs: skill.inputs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
            />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={input.required} onChange={(e) => set({ inputs: skill.inputs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />
              Required
            </label>
            <Button size="sm" variant="ghost" onClick={() => set({ inputs: skill.inputs.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        ))}
        {skill.inputs.length < AI_LIMITS.apiInputs && (
          <div>
            <Button size="sm" variant="outline" onClick={() => set({ inputs: [...skill.inputs, { key: `input_${skill.inputs.length + 1}`, description: '', required: true }] })}>
              Add an input
            </Button>
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Request</legend>
        <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <NativeSelect aria-label="Method" value={skill.request.method} onChange={(e) => setRequest({ method: e.target.value as ApiSkill['request']['method'], ...(e.target.value === 'GET' || e.target.value === 'DELETE' ? { body: null } : {}) })}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
          <Input aria-label="Address" value={skill.request.url} maxLength={2048} placeholder="https://shop.example.com/api/orders/{input:order_number}" onChange={(e) => setRequest({ url: e.target.value })} />
        </div>
        <p className="text-xs text-muted-foreground">
          Use {'{input:key}'} for an input, {'{contact:name}'}, {'{contact:phone}'} or {'{attr:key}'} for the contact. Secrets go in headers only.
        </p>
        <NameValues
          label="Header"
          rows={skill.request.headers}
          max={AI_LIMITS.apiHeaders}
          secrets={secrets}
          onChange={(headers) => setRequest({ headers })}
        />
        <NameValues label="Query parameter" rows={skill.request.query} max={AI_LIMITS.apiQuery} onChange={(query) => setRequest({ query })} />
        {hasBody && (
          <div className="grid gap-1">
            <Label htmlFor={`skill-body-${skill.id}`}>Body (JSON)</Label>
            <textarea
              id={`skill-body-${skill.id}`}
              className={`${TEXTAREA_CLASS} font-mono`}
              value={skill.request.body ?? ''}
              maxLength={AI_LIMITS.apiBodyLength}
              placeholder='{"order": "{input:order_number}"}'
              onChange={(e) => setRequest({ body: e.target.value || null })}
            />
          </div>
        )}
        <div className="grid max-w-[12rem] gap-1">
          <Label htmlFor={`skill-timeout-${skill.id}`}>Timeout (seconds)</Label>
          <Input
            id={`skill-timeout-${skill.id}`}
            type="number"
            min={AI_LIMITS.apiTimeoutMin}
            max={AI_LIMITS.apiTimeoutMax}
            value={skill.request.timeoutSeconds}
            onChange={(e) => setRequest({ timeoutSeconds: Math.min(AI_LIMITS.apiTimeoutMax, Math.max(AI_LIMITS.apiTimeoutMin, e.target.valueAsNumber || AI_LIMITS.apiTimeoutMin)) })}
          />
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Reply fields the agent may use</legend>
        {skill.map.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Input aria-label={`Field ${i + 1} path`} value={row.from} placeholder="order.status" onChange={(e) => set({ map: skill.map.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
            <Input aria-label={`Field ${i + 1} name`} value={row.to} placeholder="status" onChange={(e) => set({ map: skill.map.map((x, j) => (j === i ? { ...x, to: cleanKey(e.target.value) } : x)) })} />
            <Button size="sm" variant="ghost" onClick={() => set({ map: skill.map.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        ))}
        {skill.map.length < AI_LIMITS.apiMap && (
          <div>
            <Button size="sm" variant="outline" onClick={() => set({ map: [...skill.map, { from: '', to: `field_${skill.map.length + 1}` }] })}>
              Add a field
            </Button>
          </div>
        )}
      </fieldset>

      <SkillTest agentId={agentId} skill={skill} />
    </div>
  );
}

function NameValues({
  label,
  rows,
  max,
  secrets,
  onChange,
}: {
  label: string;
  rows: Array<{ name: string; value: string }>;
  max: number;
  secrets?: AgentSecret[];
  onChange: (rows: Array<{ name: string; value: string }>) => void;
}) {
  return (
    <div className="grid gap-2">
      {rows.map((row, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto_auto]">
          <Input aria-label={`${label} ${i + 1} name`} value={row.name} maxLength={100} placeholder="Authorization" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <Input aria-label={`${label} ${i + 1} value`} value={row.value} maxLength={2000} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          {secrets?.length ? (
            <NativeSelect
              aria-label={`Insert a secret into ${label.toLowerCase()} ${i + 1}`}
              className="w-40"
              value=""
              onChange={(e) => {
                if (e.target.value) onChange(rows.map((x, j) => (j === i ? { ...x, value: `${x.value}{secret:${e.target.value}}` } : x)));
              }}
            >
              <option value="">Insert a secret…</option>
              {secrets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <span />
          )}
          <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {rows.length < max && (
        <div>
          <Button size="sm" variant="outline" onClick={() => onChange([...rows, { name: '', value: '' }])}>
            Add a {label.toLowerCase()}
          </Button>
        </div>
      )}
    </div>
  );
}

function SkillTest({ agentId, skill }: { agentId: string; skill: ApiSkill }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: () => api<SkillTestResult>(`/ai-agents/${agentId}/skill-test`, { method: 'POST', json: { skill, inputs } }),
    onError: toastError,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run.mutate();
  };
  const result = run.data;
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-md bg-muted/40 p-3">
      <span className="text-sm font-medium">Test request</span>
      {skill.inputs.map((input) => (
        <div key={input.key} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
          <Label htmlFor={`test-${skill.id}-${input.key}`}>{input.key}</Label>
          <Input id={`test-${skill.id}-${input.key}`} value={inputs[input.key] ?? ''} maxLength={200} onChange={(e) => setInputs({ ...inputs, [input.key]: e.target.value })} />
        </div>
      ))}
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={run.isPending}>
          {run.isPending ? 'Running…' : 'Run test'}
        </Button>
      </div>
      {result && (
        <div className="grid gap-1 text-xs" data-testid="skill-test-result">
          <span className={result.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}>
            {result.ok ? 'Worked' : `Failed: ${result.error ?? 'unknown'}`}
            {result.status !== null ? ` · status ${result.status}` : ''} · {result.durationMs} ms
          </span>
          {result.mapped && Object.keys(result.mapped).length > 0 && <span>The agent would see: {JSON.stringify(result.mapped)}</span>}
          {result.body !== undefined && result.body !== null && <pre className="max-h-40 overflow-auto rounded bg-background p-2">{typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}</pre>}
        </div>
      )}
    </form>
  );
}

function SecretsPanel({ agentId, secrets, onChange }: { agentId: string; secrets: AgentSecret[]; onChange: (secrets: AgentSecret[]) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const create = useMutation({
    mutationFn: () => api<AgentSecret>(`/ai-agents/${agentId}/secrets`, { method: 'POST', json: { name: name.trim(), value } }),
    onSuccess: (secret) => {
      onChange([...secrets, secret]);
      setName('');
      setValue('');
      toast.success(`Secret "${secret.name}" stored`);
    },
    onError: toastError,
  });
  const replace = useMutation({
    mutationFn: ({ id, newValue }: { id: string; newValue: string }) => api<AgentSecret>(`/ai-agents/${agentId}/secrets/${id}`, { method: 'PUT', json: { value: newValue } }),
    onSuccess: (secret) => {
      onChange(secrets.map((s) => (s.id === secret.id ? secret : s)));
      toast.success(`Secret "${secret.name}" replaced`);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/ai-agents/${agentId}/secrets/${id}`, { method: 'DELETE' }).then(() => id),
    onSuccess: (id) => onChange(secrets.filter((s) => s.id !== id)),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'SECRET_IN_USE') toast.error(error.message);
      else toastError(error);
    },
  });

  return (
    <div className="grid gap-2 rounded-md border p-3" data-testid="secrets-panel">
      <span className="text-sm font-medium">Secrets</span>
      <p className="text-xs text-muted-foreground">Keys and tokens for headers. They are stored encrypted, never shown again, and never reach the AI service.</p>
      {secrets.length > 0 && (
        <ul className="grid gap-1">
          {secrets.map((secret) => (
            <li key={secret.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {secret.name} <span className="font-mono text-muted-foreground">••••••••</span>
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const newValue = window.prompt(`New value for "${secret.name}"`);
                    if (newValue) replace.mutate({ id: secret.id, newValue });
                  }}
                >
                  Replace value
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="ghost">
                      Delete
                    </Button>
                  }
                  title={`Delete the secret "${secret.name}"?`}
                  description="Skills that use it can no longer send it."
                  confirmLabel="Delete"
                  confirmVariant="destructive"
                  onConfirm={() => remove.mutateAsync(secret.id).catch(() => undefined)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && value) create.mutate();
        }}
      >
        <Input aria-label="Secret name" placeholder="Shop token" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Secret value" type="password" autoComplete="off" placeholder="Value" value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || !value || create.isPending}>
          Store secret
        </Button>
      </form>
    </div>
  );
}
