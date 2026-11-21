'use client';

import { AI_LIMITS, DEFAULT_INTROS, type AgentConfig, type AgentProblem } from '@wbm/shared';
import { useState } from 'react';
import { TEXTAREA_CLASS } from '@/components/flows/steps/form-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { LANGUAGES, TONES, languageName } from '@/lib/ai';

interface InstructionsTabProps {
  config: AgentConfig;
  problems: AgentProblem[];
  onChange: (patch: Partial<AgentConfig>) => void;
}

/** Problems for a field or anything inside it ("intro" also matches "intro.en"). */
function problemsFor(problems: AgentProblem[], field: string): AgentProblem[] {
  return problems.filter((p) => p.field === field || p.field?.startsWith(`${field}.`));
}

function FieldProblems({ problems }: { problems: AgentProblem[] }) {
  if (!problems.length) return null;
  return (
    <ul className="grid gap-0.5">
      {problems.map((p, i) => (
        <li key={`${p.code}:${i}`} className="text-xs text-destructive">
          {p.message}
        </li>
      ))}
    </ul>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className="text-xs text-muted-foreground">
      {value.length}/{max}
    </span>
  );
}

/**
 * Who the agent is and how it replies (004 T045, FR-006–FR-009): display name, business details, goal,
 * tone, guardrails, reply languages with their introductions, and the longest reply.
 */
export function InstructionsTab({ config, problems, onChange }: InstructionsTabProps) {
  const [rule, setRule] = useState('');
  const languages = [...LANGUAGES.map((l) => l.code), ...config.replyLanguages.filter((code) => !LANGUAGES.some((l) => l.code === code))];

  function toggleLanguage(code: string, on: boolean) {
    if (on) {
      if (config.replyLanguages.length >= AI_LIMITS.replyLanguages) return;
      onChange({ replyLanguages: [...config.replyLanguages, code], intro: { ...config.intro, [code]: config.intro[code] ?? DEFAULT_INTROS[code] ?? '' } });
    } else {
      const { [code]: _removed, ...intro } = config.intro;
      onChange({ replyLanguages: config.replyLanguages.filter((c) => c !== code), intro });
    }
  }

  function addRule() {
    const text = rule.trim().slice(0, AI_LIMITS.guardrailLength);
    if (!text || config.guardrails.length >= AI_LIMITS.guardrails) return;
    onChange({ guardrails: [...config.guardrails, text] });
    setRule('');
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-4" aria-labelledby="about-title">
        <h2 id="about-title" className="text-base font-semibold">
          About the agent
        </h2>
        <div className="grid gap-1">
          <Label htmlFor="ai-display-name">Display name</Label>
          <Input
            id="ai-display-name"
            value={config.displayName}
            maxLength={AI_LIMITS.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            className="max-w-sm"
          />
          <p className="text-xs text-muted-foreground">The name customers see when the agent introduces itself.</p>
          <FieldProblems problems={problemsFor(problems, 'displayName')} />
        </div>
        <div className="grid gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="ai-goal">Goal</Label>
            <Counter value={config.goal} max={AI_LIMITS.goal} />
          </div>
          <textarea
            id="ai-goal"
            className={TEXTAREA_CLASS}
            value={config.goal}
            maxLength={AI_LIMITS.goal}
            placeholder="Answer questions about our products and delivery, and help customers place orders."
            onChange={(e) => onChange({ goal: e.target.value })}
          />
          <FieldProblems problems={problemsFor(problems, 'goal')} />
        </div>
        <div className="grid gap-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="ai-business">Business details</Label>
            <Counter value={config.businessDetails} max={AI_LIMITS.businessDetails} />
          </div>
          <textarea
            id="ai-business"
            className={`${TEXTAREA_CLASS} min-h-[140px]`}
            value={config.businessDetails}
            maxLength={AI_LIMITS.businessDetails}
            placeholder="What you sell, where you are, opening hours: facts the agent may share with customers."
            onChange={(e) => onChange({ businessDetails: e.target.value })}
          />
        </div>
      </section>

      <section className="grid gap-4" aria-labelledby="style-title">
        <h2 id="style-title" className="text-base font-semibold">
          How it writes
        </h2>
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="grid gap-1">
            <Label htmlFor="ai-tone">Tone</Label>
            <NativeSelect
              id="ai-tone"
              value={config.tone.preset}
              onChange={(e) => onChange({ tone: { ...config.tone, preset: e.target.value as AgentConfig['tone']['preset'] } })}
            >
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="ai-tone-notes">Tone notes (optional)</Label>
            <Input
              id="ai-tone-notes"
              value={config.tone.notes}
              maxLength={AI_LIMITS.toneNotes}
              placeholder="Use short sentences. No emojis."
              onChange={(e) => onChange({ tone: { ...config.tone, notes: e.target.value } })}
            />
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ai-max-reply">Longest reply (characters)</Label>
          <Input
            id="ai-max-reply"
            type="number"
            className="max-w-[10rem]"
            min={AI_LIMITS.maxReplyCharsMin}
            max={AI_LIMITS.maxReplyCharsMax}
            step={50}
            value={Number.isFinite(config.maxReplyChars) ? config.maxReplyChars : ''}
            onChange={(e) => onChange({ maxReplyChars: e.target.valueAsNumber })}
          />
          <p className="text-xs text-muted-foreground">
            Between {AI_LIMITS.maxReplyCharsMin} and {AI_LIMITS.maxReplyCharsMax}. Short replies read better on a phone.
          </p>
        </div>
      </section>

      <section className="grid gap-3" aria-labelledby="rules-title">
        <div>
          <h2 id="rules-title" className="text-base font-semibold">
            Guardrails
          </h2>
          <p className="text-sm text-muted-foreground">
            Things the agent must never do or talk about. It never invents prices or promises and never asks for card or ID numbers in any case.
          </p>
        </div>
        {config.guardrails.length > 0 && (
          <ul className="grid gap-2" data-testid="guardrails">
            {config.guardrails.map((text, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Guardrail ${i + 1}`}
                  value={text}
                  maxLength={AI_LIMITS.guardrailLength}
                  onChange={(e) => onChange({ guardrails: config.guardrails.map((g, j) => (j === i ? e.target.value : g)) })}
                  onBlur={(e) => {
                    if (!e.target.value.trim()) onChange({ guardrails: config.guardrails.filter((_, j) => j !== i) });
                  }}
                />
                <Button size="sm" variant="ghost" aria-label={`Remove guardrail ${i + 1}`} onClick={() => onChange({ guardrails: config.guardrails.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addRule();
          }}
        >
          <Input
            aria-label="New guardrail"
            value={rule}
            maxLength={AI_LIMITS.guardrailLength}
            placeholder="Do not discuss competitors."
            onChange={(e) => setRule(e.target.value)}
            disabled={config.guardrails.length >= AI_LIMITS.guardrails}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!rule.trim() || config.guardrails.length >= AI_LIMITS.guardrails}>
            Add
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          {config.guardrails.length}/{AI_LIMITS.guardrails} guardrails
        </p>
      </section>

      <section className="grid gap-3" aria-labelledby="languages-title">
        <div>
          <h2 id="languages-title" className="text-base font-semibold">
            Languages and introduction
          </h2>
          <p className="text-sm text-muted-foreground">
            The agent replies in the customer&apos;s language when it is on this list, otherwise in the first one. Before its first reply in a chat it introduces
            itself as a virtual assistant; {'{name}'} becomes the display name.
          </p>
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="sr-only">Reply languages</legend>
          {languages.map((code) => (
            <label key={code} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={config.replyLanguages.includes(code)} onChange={(e) => toggleLanguage(code, e.target.checked)} />
              {languageName(code)}
            </label>
          ))}
        </fieldset>
        <FieldProblems problems={problemsFor(problems, 'replyLanguages')} />
        <div className="grid gap-3">
          {config.replyLanguages.map((code) => (
            <div key={code} className="grid gap-1">
              <Label htmlFor={`ai-intro-${code}`}>Introduction in {languageName(code)}</Label>
              <Input
                id={`ai-intro-${code}`}
                dir={code === 'ar' || code === 'ur' || code === 'fa' ? 'rtl' : undefined}
                value={config.intro[code] ?? ''}
                maxLength={AI_LIMITS.intro}
                onChange={(e) => onChange({ intro: { ...config.intro, [code]: e.target.value } })}
              />
              <FieldProblems problems={problemsFor(problems, `intro.${code}`)} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
