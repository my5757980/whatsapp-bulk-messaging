import { describe, expect, it } from 'vitest';
import { AGENT_REPLY_JSON_SCHEMA, AgentReplySchema, sanitiseReply, type AgentReply, type ReplyContext } from './reply.js';

// T010: the reply JSON (specs/004-ai-agent/contracts/claude-messages.md §4) and the checks in code.
const empty: AgentReply = {
  message: '',
  language: null,
  buttons: null,
  list: null,
  mediaId: null,
  usedSources: [],
  unanswered: null,
  handOver: null,
  remember: null,
  startFlow: null,
  optOut: null,
};

const context: ReplyContext = {
  maxReplyChars: 200,
  allowButtons: true,
  allowLists: true,
  mediaIds: new Set(['media-1']),
  flowIds: new Set(['flow-1']),
  attributes: new Map([
    ['city', 'TEXT'],
    ['budget', 'NUMBER'],
    ['visit_date', 'DATE'],
    ['vip', 'BOOLEAN'],
  ]),
  sourceIds: new Set(['src:1', 'chunk:2']),
};

const reasons = (dropped: Array<{ field: string; reason: string }>) => dropped.map((d) => `${d.field}:${d.reason}`);

describe('AgentReplySchema', () => {
  it('parses the contract example', () => {
    const parsed = AgentReplySchema.safeParse({
      message: 'Yes, we deliver to Sharjah. Delivery is AED 50, free over AED 1,000.',
      language: 'en',
      buttons: null,
      list: null,
      mediaId: null,
      usedSources: ['src:1'],
      unanswered: null,
      handOver: null,
      remember: null,
      startFlow: null,
      optOut: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('exports a strict JSON schema the API accepts (every property required, no extra keys)', () => {
    const schema = AGENT_REPLY_JSON_SCHEMA as { type: string; required: string[]; additionalProperties: boolean; $schema?: string };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(Object.keys(empty)));
    expect(schema.$schema).toBeUndefined();
    expect(JSON.stringify(schema)).not.toMatch(/minLength|maxLength|minimum|maximum/);
  });
});

describe('sanitiseReply', () => {
  it('keeps a valid reply unchanged', () => {
    const reply = { ...empty, message: 'Hello', language: 'en', usedSources: ['src:1'] };
    expect(sanitiseReply(reply, context)).toEqual({ reply, dropped: [] });
  });

  it('drops a 4th button, long or duplicate titles, and lists sent together with buttons', () => {
    const { reply, dropped } = sanitiseReply(
      {
        ...empty,
        message: 'Choose a branch',
        buttons: ['Dubai', 'Sharjah', 'Sharjah', 'A very long branch name here', 'Ajman', 'Al Ain'],
        list: { button: 'Branches', rows: [{ title: 'Dubai', description: null }] },
      },
      context,
    );
    expect(reply.buttons).toEqual(['Dubai', 'Sharjah', 'Ajman']);
    expect(reply.list).toBeNull();
    expect(reasons(dropped)).toEqual(expect.arrayContaining(['buttons:duplicate', 'buttons:too_long', 'buttons:too_many', 'list:with_buttons']));
  });

  it('trims lists to WhatsApp limits and drops them when the skill is off', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ title: `Option ${i + 1}`, description: i === 0 ? 'x'.repeat(80) : null }));
    const { reply, dropped } = sanitiseReply({ ...empty, message: 'Pick one', list: { button: 'Options', rows } }, context);
    expect(reply.list?.rows).toHaveLength(10);
    expect(reply.list?.rows[0]?.description).toBeNull();
    expect(reasons(dropped)).toEqual(expect.arrayContaining(['list:too_many_rows', 'list:description_too_long']));

    const off = sanitiseReply({ ...empty, message: 'Pick one', list: { button: 'Options', rows } }, { ...context, allowLists: false });
    expect(off.reply.list).toBeNull();
    expect(reasons(off.dropped)).toContain('list:not_allowed');
  });

  it('drops media and flows that are not in the version, and unknown sources', () => {
    const { reply, dropped } = sanitiseReply(
      { ...empty, message: 'Here', mediaId: 'media-9', startFlow: 'flow-9', usedSources: ['src:1', 'src:404'] },
      context,
    );
    expect(reply).toMatchObject({ mediaId: null, startFlow: null, usedSources: ['src:1'] });
    expect(reasons(dropped)).toEqual(expect.arrayContaining(['mediaId:unknown', 'startFlow:unknown', 'usedSources:unknown']));
  });

  it('keeps only remembered values for allowed attributes of the right type, never sensitive numbers', () => {
    const { reply, dropped } = sanitiseReply(
      {
        ...empty,
        message: 'Noted',
        remember: [
          { key: 'city', value: 'Al Ain' },
          { key: 'budget', value: 'about 5000' },
          { key: 'budget', value: '5000' },
          { key: 'visit_date', value: '2026-12-01' },
          { key: 'vip', value: 'yes' },
          { key: 'passport', value: 'X123' },
          { key: 'city', value: '4111 1111 1111 1111' },
        ],
      },
      context,
    );
    expect(reply.remember).toEqual([
      { key: 'city', value: 'Al Ain' },
      { key: 'budget', value: '5000' },
      { key: 'visit_date', value: '2026-12-01' },
      { key: 'vip', value: 'true' },
    ]);
    expect(reasons(dropped)).toEqual(expect.arrayContaining(['remember.budget:wrong_type', 'remember.passport:not_allowed', 'remember.city:sensitive']));
  });

  it('shortens messages over the limit (1,024 with media) at a word boundary', () => {
    const long = `${'word '.repeat(60)}end`;
    const { reply, dropped } = sanitiseReply({ ...empty, message: long }, context);
    expect([...reply.message].length).toBeLessThanOrEqual(200);
    expect(reply.message.endsWith('…')).toBe(true);
    expect(reasons(dropped)).toContain('message:too_long');

    const media = sanitiseReply({ ...empty, message: 'x'.repeat(1500), mediaId: 'media-1' }, { ...context, maxReplyChars: 1000 });
    expect([...media.reply.message].length).toBeLessThanOrEqual(1024);
  });
});
