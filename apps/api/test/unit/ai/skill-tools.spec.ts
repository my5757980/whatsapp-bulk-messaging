import { ApiSkillSchema, type ApiSkill } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import { ApiCallError, type ApiRequest, type ApiResponse } from '../../../src/modules/flows/steps/api-client.js';
import { buildSkillRequest, skillSecretIds, skillSession, type SkillRuntime } from '../../../src/modules/ai/claude/skills.js';

// 004 T070: API skill tools (FR-030, FR-031; research R12).
const SECRET_ID = '0190a000-0000-7000-8000-00000000abcd';

const orderStatus: ApiSkill = ApiSkillSchema.parse({
  id: 'order_status',
  name: 'Order status',
  whenToUse: 'When the customer asks where their order is.',
  inputs: [{ key: 'order_number', description: 'The order number, like 10234' }],
  request: {
    method: 'GET',
    url: 'https://shop.example.com/api/orders/{input:order_number}',
    headers: [{ name: 'Authorization', value: `Bearer {secret:${SECRET_ID}}` }],
    query: [{ name: 'customer', value: '{contact:name}' }],
  },
  map: [{ from: 'order.status', to: 'status' }],
});

const cancelOrder: ApiSkill = ApiSkillSchema.parse({
  id: 'cancel_order',
  name: 'Cancel order',
  whenToUse: 'When the customer wants to cancel an order.',
  inputs: [{ key: 'order_number' }, { key: 'reason', required: false }],
  changesData: true,
  request: { method: 'POST', url: 'https://shop.example.com/api/orders/{input:order_number}/cancel', body: '{"reason":"{input:reason}"}' },
  map: [{ from: 'cancelled', to: 'cancelled' }],
});

function runtime(overrides: Partial<SkillRuntime> = {}) {
  const requests: ApiRequest[] = [];
  const reply: ApiResponse = { status: 200, body: { order: { status: 'shipped', internal_note: 'VIP, refund twice' }, cancelled: true }, text: '' };
  const value: SkillRuntime = {
    mode: 'live',
    contact: { name: 'Sara Ali', phoneE164: '+971501234567', attributes: {} },
    secrets: new Map([[SECRET_ID, 'tok_123']]),
    pending: null,
    call: async (request) => {
      requests.push(request);
      return reply;
    },
    ...overrides,
  };
  return { value, requests };
}

describe('API skill tools (T070)', () => {
  it('makes one strict tool skill_<id> per skill from its inputs', () => {
    const [cancel, status] = skillSession([cancelOrder, orderStatus], runtime().value).tools;
    expect(status!.name).toBe('skill_order_status');
    expect(status!.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['order_number'],
      properties: { order_number: { type: 'string', description: 'The order number, like 10234' } },
    });
    expect(cancel!.name).toBe('skill_cancel_order');
    expect(cancel!.inputSchema).toMatchObject({ required: ['order_number', 'reason'], properties: { reason: { type: ['string', 'null'] } } });
    expect(cancel!.description).toContain('call it only after they confirm');
  });

  it('fills inputs with place-aware encoding and the secret only in the header', () => {
    const request = buildSkillRequest(orderStatus, { order_number: '10/23 4?x=1' }, runtime().value);
    expect(request.url).toBe('https://shop.example.com/api/orders/10%2F23%204%3Fx%3D1?customer=Sara+Ali');
    expect(request.headers).toEqual({ Authorization: 'Bearer tok_123' });
    expect(skillSecretIds(orderStatus)).toEqual([SECRET_ID]);
    const body = buildSkillRequest(cancelOrder, { order_number: '5', reason: 'too "late"\n' }, runtime().value).body;
    expect(JSON.parse(body!)).toEqual({ reason: 'too "late"\n' });
  });

  it('gives the model only the mapped fields', async () => {
    const session = skillSession([orderStatus], runtime().value);
    const result = await session.tools[0]!.run({ order_number: '10234' });
    expect(JSON.parse(result)).toEqual({ ok: true, fields: { status: 'shipped' } });
    expect(result).not.toContain('VIP');
    expect(session.calls).toEqual([{ skillId: 'order_status', name: 'Order status', outcome: 'OK' }]);
  });

  it('reports timeouts, error statuses and refused addresses without inventing a result', async () => {
    const failing = (error: unknown) => runtime({ call: async () => Promise.reject(error) }).value;
    expect(JSON.parse(await skillSession([orderStatus], failing(new ApiCallError('TIMEOUT', 'slow'))).tools[0]!.run({ order_number: '1' }))).toEqual({ ok: false, reason: 'timeout' });
    expect(JSON.parse(await skillSession([orderStatus], failing(new ApiCallError('BLOCKED_ADDRESS', 'private'))).tools[0]!.run({ order_number: '1' }))).toEqual({ ok: false, reason: 'blocked' });
    const status500 = runtime({ call: async () => ({ status: 500, body: null, text: 'oops' }) }).value;
    const session = skillSession([orderStatus], status500);
    expect(JSON.parse(await session.tools[0]!.run({ order_number: '1' }))).toEqual({ ok: false, reason: 'error_status' });
    expect(session.calls[0]!.outcome).toBe('FAILED');
  });

  it('asks for confirmation before a skill that changes data, runs it on a later turn with the same inputs, and asks again for other inputs', async () => {
    const first = runtime();
    const turn1 = skillSession([cancelOrder], first.value);
    expect(JSON.parse(await turn1.tools[0]!.run({ order_number: '10234', reason: null }))).toEqual({ ok: false, reason: 'confirmation_needed' });
    expect(first.requests).toHaveLength(0);
    const pending = turn1.pending();
    expect(pending).toEqual({ skillId: 'cancel_order', skillName: 'Cancel order', inputs: { order_number: '10234' } });

    const other = runtime({ pending });
    const turn2 = skillSession([cancelOrder], other.value);
    expect(JSON.parse(await turn2.tools[0]!.run({ order_number: '99999', reason: null }))).toEqual({ ok: false, reason: 'confirmation_needed' });
    expect(other.requests).toHaveLength(0);
    expect(turn2.pending()?.inputs).toEqual({ order_number: '99999' });

    const confirmed = runtime({ pending });
    const turn3 = skillSession([cancelOrder], confirmed.value);
    expect(JSON.parse(await turn3.tools[0]!.run({ order_number: '10234', reason: null }))).toEqual({ ok: true, fields: { cancelled: 'true' } });
    expect(confirmed.requests).toHaveLength(1);
    expect(turn3.pending()).toBeNull();
    expect(turn3.calls).toEqual([{ skillId: 'cancel_order', name: 'Cancel order', outcome: 'OK' }]);
  });

  it('keeps an earlier confirmation when the turn calls nothing, and only simulates changes in the preview', async () => {
    const pending = { skillId: 'cancel_order', skillName: 'Cancel order', inputs: { order_number: '1' } };
    expect(skillSession([cancelOrder], runtime({ pending }).value).pending()).toEqual(pending);

    const preview = runtime({ mode: 'preview' });
    const session = skillSession([cancelOrder, orderStatus], preview.value);
    expect(JSON.parse(await session.tools[0]!.run({ order_number: '7', reason: 'moved' }))).toEqual({ ok: true, fields: {}, simulated: true });
    expect(session.wouldDo).toEqual(['Would call "Cancel order" with order_number = 7, reason = moved']);
    expect(preview.requests).toHaveLength(0);
    // Read-only skills run in the preview, so the manager sees real answers.
    expect(JSON.parse(await session.tools[1]!.run({ order_number: '7' }))).toEqual({ ok: true, fields: { status: 'shipped' } });
    expect(preview.requests).toHaveLength(1);
  });
});
