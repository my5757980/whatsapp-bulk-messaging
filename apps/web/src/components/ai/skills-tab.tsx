'use client';

import { useQuery } from '@tanstack/react-query';
import { AI_LIMITS, type AgentConfig, type AgentProblem } from '@wbm/shared';
import { useState } from 'react';
import { MediaPicker, mediaLibraryKey, type MediaItem } from '@/components/inbox/media-picker';
import { ApiSkills, type AgentSecret } from './api-skill-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { flowKeys, type FlowSummary } from '@/lib/flows';
import { queryKeys } from '@/lib/query';
import type { AttributeDefinition } from '@/lib/types';

interface SkillsTabProps {
  agentId: string;
  /** The agent's stored secrets (names only), for API skill headers. */
  secrets: AgentSecret[];
  config: AgentConfig;
  problems: AgentProblem[];
  onChange: (patch: Partial<AgentConfig>) => void;
}

function FieldProblems({ problems, prefix }: { problems: AgentProblem[]; prefix: string }) {
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

/**
 * What the agent may do besides writing text (004 T069, FR-028, FR-029): reply buttons and lists,
 * files from the media library it may send (each with when to send it), and contact attributes it
 * may fill from what the customer says (each with what it holds).
 */
export function SkillsTab({ agentId, secrets: initialSecrets, config, problems, onChange }: SkillsTabProps) {
  const skills = config.skills;
  const setSkills = (patch: Partial<AgentConfig['skills']>) => onChange({ skills: { ...skills, ...patch } });
  const [secrets, setSecrets] = useState<AgentSecret[]>(initialSecrets);
  const library = useQuery({ queryKey: mediaLibraryKey, queryFn: () => api<{ items: MediaItem[] }>('/media-library?pageSize=60') });
  const attributes = useQuery({ queryKey: queryKeys.attributes, queryFn: () => api<AttributeDefinition[]>('/attributes') });
  const [attributeKey, setAttributeKey] = useState('');
  const fileName = (id: string) => library.data?.items.find((item) => item.id === id)?.displayName ?? 'File from the media library';
  const offered = (attributes.data ?? []).filter((a) => !skills.memory.some((m) => m.key === a.key));

  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-labelledby="options-title">
        <div>
          <h2 id="options-title" className="text-base font-semibold">
            Replies with options
          </h2>
          <p className="text-sm text-muted-foreground">Let the agent offer choices the customer can tap instead of typing.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={skills.buttons} onChange={(e) => setSkills({ buttons: e.target.checked })} />
          Reply buttons (up to 3)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={skills.lists} onChange={(e) => setSkills({ lists: e.target.checked })} />
          Lists (up to 10 options)
        </label>
      </section>

      <section className="grid gap-3" aria-labelledby="files-title">
        <div>
          <h2 id="files-title" className="text-base font-semibold">
            Files it may send
          </h2>
          <p className="text-sm text-muted-foreground">Price lists, catalogues or maps from the media library. Say when each one should be sent.</p>
        </div>
        {skills.media.length > 0 && (
          <ul className="grid gap-3" data-testid="skill-media">
            {skills.media.map((item, i) => (
              <li key={item.mediaId} className="grid gap-1 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{fileName(item.mediaId)}</span>
                  <Button size="sm" variant="ghost" onClick={() => setSkills({ media: skills.media.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
                <Label htmlFor={`skill-media-${i}`}>When to send it</Label>
                <Input
                  id={`skill-media-${i}`}
                  value={item.description}
                  maxLength={AI_LIMITS.skillDescription}
                  placeholder="When someone asks for prices"
                  onChange={(e) => setSkills({ media: skills.media.map((m, j) => (j === i ? { ...m, description: e.target.value } : m)) })}
                />
                <FieldProblems problems={problems} prefix={`skills.media[${i}]`} />
              </li>
            ))}
          </ul>
        )}
        {skills.media.length < AI_LIMITS.media ? (
          <div>
            <MediaPicker
              purpose="choose"
              onSend={(item) => {
                if (!skills.media.some((m) => m.mediaId === item.id)) setSkills({ media: [...skills.media, { mediaId: item.id, description: '' }] });
              }}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">That is the most files an agent can have.</p>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby="memory-title">
        <div>
          <h2 id="memory-title" className="text-base font-semibold">
            What it may remember
          </h2>
          <p className="text-sm text-muted-foreground">
            Contact attributes the agent fills from what the customer says, for example their city. It never saves card, bank or ID numbers.
          </p>
        </div>
        {skills.memory.length > 0 && (
          <ul className="grid gap-3" data-testid="skill-memory">
            {skills.memory.map((item, i) => {
              const definition = attributes.data?.find((a) => a.key === item.key);
              return (
                <li key={item.key} className="grid gap-1 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {definition?.label ?? item.key} <span className="font-normal text-muted-foreground">({item.key})</span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setSkills({ memory: skills.memory.filter((_, j) => j !== i) })}>
                      Remove
                    </Button>
                  </div>
                  <Label htmlFor={`skill-memory-${i}`}>What it holds</Label>
                  <Input
                    id={`skill-memory-${i}`}
                    value={item.description}
                    maxLength={AI_LIMITS.skillDescription}
                    placeholder="The city the customer lives in"
                    onChange={(e) => setSkills({ memory: skills.memory.map((m, j) => (j === i ? { ...m, description: e.target.value } : m)) })}
                  />
                  <FieldProblems problems={problems} prefix={`skills.memory[${i}]`} />
                </li>
              );
            })}
          </ul>
        )}
        {skills.memory.length < AI_LIMITS.memory && (
          <div className="flex items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="skill-memory-new">Attribute</Label>
              <NativeSelect id="skill-memory-new" className="w-64" value={attributeKey} onChange={(e) => setAttributeKey(e.target.value)}>
                <option value="">Choose an attribute…</option>
                {offered.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label} ({a.key})
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!attributeKey}
              onClick={() => {
                setSkills({ memory: [...skills.memory, { key: attributeKey, description: '' }] });
                setAttributeKey('');
              }}
            >
              Add
            </Button>
          </div>
        )}
      </section>

      <ApiSkills agentId={agentId} skills={skills.api} secrets={secrets} problems={problems} onChange={(api) => setSkills({ api })} onSecretsChange={setSecrets} />

      <FlowSkills config={config} problems={problems} onChange={(flows) => setSkills({ flows })} />
    </div>
  );
}

/**
 * Start a flow skills (004 T084, FR-032): published flows the agent may start, each with when to use
 * it. The flow answers while it runs; the agent continues after it.
 */
function FlowSkills({ config, problems, onChange }: { config: AgentConfig; problems: AgentProblem[]; onChange: (flows: AgentConfig['skills']['flows']) => void }) {
  const chosen = config.skills.flows;
  const flows = useQuery({ queryKey: flowKeys.list, queryFn: () => api<FlowSummary[]>('/flows') });
  const [flowId, setFlowId] = useState('');
  const nameOf = (id: string) => flows.data?.find((f) => f.id === id)?.name ?? 'A deleted flow';
  const offered = (flows.data ?? []).filter((f) => f.status === 'PUBLISHED' && !chosen.some((c) => c.flowId === f.id));

  return (
    <section className="grid gap-3" aria-labelledby="flow-skills-title">
      <div>
        <h2 id="flow-skills-title" className="text-base font-semibold">
          Flows it may start
        </h2>
        <p className="text-sm text-muted-foreground">
          For things a chatbot flow does best, such as booking a visit. The flow answers while it runs, then the agent continues.
        </p>
      </div>
      {chosen.length > 0 && (
        <ul className="grid gap-3" data-testid="skill-flows">
          {chosen.map((item, i) => (
            <li key={item.flowId} className="grid gap-1 rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{nameOf(item.flowId)}</span>
                <Button size="sm" variant="ghost" onClick={() => onChange(chosen.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
              <Label htmlFor={`skill-flow-${i}`}>When to start it</Label>
              <Input
                id={`skill-flow-${i}`}
                value={item.whenToUse}
                maxLength={AI_LIMITS.whenToUse}
                placeholder="When the customer wants to book a showroom visit"
                onChange={(e) => onChange(chosen.map((f, j) => (j === i ? { ...f, whenToUse: e.target.value } : f)))}
              />
              <FieldProblems problems={problems} prefix={`skills.flows[${i}]`} />
            </li>
          ))}
        </ul>
      )}
      {chosen.length < AI_LIMITS.flowSkills && (
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="skill-flow-new">Published flow</Label>
            <NativeSelect id="skill-flow-new" className="w-64" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
              <option value="">Choose a flow…</option>
              {offered.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!flowId}
            onClick={() => {
              onChange([...chosen, { flowId, whenToUse: '' }]);
              setFlowId('');
            }}
          >
            Add flow
          </Button>
        </div>
      )}
    </section>
  );
}
