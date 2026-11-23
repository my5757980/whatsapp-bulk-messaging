import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, agentConfigProblems, defaultAgentConfig, type AgentConfig } from './config.js';

// T008: the agent configuration document (specs/004-ai-agent/contracts/agent-config.md).
const example = {
  version: 1,
  displayName: 'Sara',
  businessDetails: 'We sell sofas and beds in Dubai and Sharjah.',
  goal: 'Answer questions about our furniture and delivery, and help customers choose.',
  tone: { preset: 'friendly', notes: 'Short sentences.' },
  guardrails: ['Never offer discounts that are not in the knowledge.'],
  replyLanguages: ['en', 'ar'],
  intro: { en: "Hi, I'm Sara, a virtual assistant.", ar: 'مرحباً، أنا سارة، مساعدة افتراضية.' },
  maxReplyChars: 1000,
  whenUnsure: 'say_so',
  handOverTopics: ['refunds', 'complaints'],
  replyCap: 20,
  fallbackMessage: 'Thanks for your message. Our team will reply shortly.',
  skills: {
    buttons: true,
    lists: true,
    media: [{ mediaId: '0190a000-0000-7000-8000-000000000001', description: 'Our price list. Send it when asked for prices.' }],
    memory: [{ key: 'city', description: 'The emirate or city the customer lives in.' }],
    api: [
      {
        id: 'order_status',
        name: 'Order status',
        whenToUse: 'Use when a customer asks where their order is.',
        inputs: [{ key: 'order_number', description: 'The order number, like A-1234.', required: true }],
        changesData: false,
        request: {
          method: 'GET',
          url: 'https://shop.example.com/api/orders/{input:order_number}',
          headers: [{ name: 'Authorization', value: 'Bearer {secret:0190a000-0000-7000-8000-000000000002}' }],
          query: [],
          body: null,
          timeoutSeconds: 5,
        },
        map: [{ from: 'status', to: 'status' }],
      },
    ],
    flows: [{ flowId: '0190a000-0000-7000-8000-000000000003', whenToUse: 'When the customer wants to book a showroom visit.' }],
  },
};

const parse = (value: unknown) => AgentConfigSchema.safeParse(value);
const withChanges = (changes: Record<string, unknown>) => ({ ...example, ...changes });
const codes = (config: AgentConfig) => agentConfigProblems(config).map((p) => p.code);

describe('AgentConfigSchema', () => {
  it('parses the contract example', () => {
    const result = parse(example);
    expect(result.success).toBe(true);
    expect(agentConfigProblems(result.data as AgentConfig)).toEqual([]);
  });

  it('fills defaults, with our introductions for English and Arabic', () => {
    const config = defaultAgentConfig('Sara');
    expect(parse(config).success).toBe(true);
    expect(config.replyLanguages).toEqual(['en', 'ar']);
    expect(config.intro.en).toContain('{name}');
    expect(config.intro.ar).toContain('{name}');
    expect(config).toMatchObject({ whenUnsure: 'say_so', replyCap: 20, maxReplyChars: 1000 });
  });

  it('refuses unknown fields and values outside the limits', () => {
    expect(parse(withChanges({ extra: true })).success).toBe(false);
    expect(parse(withChanges({ guardrails: Array.from({ length: 21 }, (_, i) => `rule ${i}`) })).success).toBe(false);
    expect(parse(withChanges({ replyCap: 4 })).success).toBe(false);
    expect(parse(withChanges({ replyCap: 101 })).success).toBe(false);
    expect(parse(withChanges({ maxReplyChars: 1001 })).success).toBe(false);
    expect(parse(withChanges({ maxReplyChars: 99 })).success).toBe(false);
    expect(parse(withChanges({ replyLanguages: ['english'] })).success).toBe(false);
  });

  it('refuses an 11th API skill and bad skill ids', () => {
    const skill = example.skills.api[0]!;
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...skill, id: `skill_${i}` }));
    expect(parse(withChanges({ skills: { ...example.skills, api: eleven } })).success).toBe(false);
    expect(parse(withChanges({ skills: { ...example.skills, api: [{ ...skill, id: 'Order-Status' }] } })).success).toBe(false);
    expect(parse(withChanges({ skills: { ...example.skills, api: [{ ...skill, request: { ...skill.request, timeoutSeconds: 11 } }] } })).success).toBe(false);
  });

  it('keeps unfinished drafts savable and reports what blocks publishing', () => {
    const draft = parse(withChanges({ goal: '', replyLanguages: [] }));
    expect(draft.success).toBe(true);
    expect(codes(draft.data as AgentConfig)).toEqual(expect.arrayContaining(['NO_GOAL', 'NO_LANGUAGE']));
  });

  it('reports missing introductions, descriptions, duplicate ids and unsafe requests', () => {
    const skill = example.skills.api[0]!;
    const config = parse(
      withChanges({
        replyLanguages: ['en', 'ur'],
        skills: {
          ...example.skills,
          memory: [{ key: 'city', description: '' }],
          api: [
            { ...skill, request: { ...skill.request, url: 'http://shop.example.com/orders' } },
            { ...skill, whenToUse: '', request: { ...skill.request, query: [{ name: 'key', value: '{secret:0190a000-0000-7000-8000-000000000002}' }] } },
            { ...skill, id: 'refund', request: { ...skill.request, url: 'https://shop.example.com/{input:missing}' } },
          ],
        },
      }),
    );
    expect(config.success).toBe(true);
    const found = agentConfigProblems(config.data as AgentConfig);
    expect(found.map((p) => p.code)).toEqual(
      expect.arrayContaining(['INTRO_MISSING', 'SKILL_WITHOUT_DESCRIPTION', 'NOT_HTTPS', 'DUPLICATE_SKILL_ID', 'SECRET_OUTSIDE_HEADER', 'UNKNOWN_INPUT']),
    );
    expect(found.find((p) => p.code === 'NOT_HTTPS')?.field).toBe('skills.api[0].request.url');
  });
});
