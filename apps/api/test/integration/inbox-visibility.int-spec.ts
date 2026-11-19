import type { Prisma } from '../../src/generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canAccess, visibleSql } from '../../src/modules/inbox/conversations/visibility.js';
import { seedNumber, uaePhone } from '../support/fixtures.js';
import { admin, AGENT_B_ID, agentA, manager, TAG_DEMO, TAG_VIP, VISIBILITY_CASES } from '../support/inbox-visibility-cases.js';
import { createTestContext, type TestContext } from '../support/test-context.js';

// T008: the SQL visibility predicate used by lists gives the same answer as the in-memory rule used
// by single-chat checks and live events, on the same table of cases (research R7, SC-008).
let ctx: TestContext;
let numberId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const users: Array<[string, 'ADMIN' | 'MANAGER' | 'AGENT']> = [
    [admin.id, 'ADMIN'],
    [manager.id, 'MANAGER'],
    [agentA.id, 'AGENT'],
    [AGENT_B_ID, 'AGENT'],
  ];
  for (const [id, role] of users) {
    await ctx.prisma.user.upsert({ where: { id }, create: { id, email: `visibility-${id}@test.local`, name: `${role} visibility`, role, status: 'ACTIVE' }, update: {} });
  }
  for (const [id, name] of [
    [TAG_DEMO, 'visibility-demo'],
    [TAG_VIP, 'visibility-vip'],
  ] as const) {
    await ctx.prisma.tag.upsert({ where: { id }, create: { id, name }, update: {} });
  }
  numberId = (await seedNumber(ctx)).id;
});

afterAll(async () => {
  await ctx.close();
});

describe('visibility SQL agrees with the in-memory rule', () => {
  it.each(VISIBILITY_CASES)('%s', async (_label, viewer, rules, facts, expected) => {
    const contact = await ctx.prisma.contact.create({
      data: {
        phoneE164: uaePhone(),
        countryCode: 'AE',
        attributes: facts.contactAttributes as Prisma.InputJsonValue,
        tags: { create: facts.contactTagIds.map((tagId) => ({ tagId })) },
      },
    });
    const chat = await ctx.prisma.conversation.create({
      data: {
        contactId: contact.id,
        numberId,
        state: facts.state,
        intervenedById: facts.intervenedById,
        intervenedAt: facts.intervenedById ? new Date() : null,
      },
    });

    const rows = await ctx.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM conversations c LEFT JOIN contacts k ON k.id = c.contact_id
       WHERE c.id = ${chat.id}::uuid AND ${visibleSql(viewer, rules, { conversation: 'c', contact: 'k' })}`;

    expect(rows.length === 1).toBe(expected);
    expect(canAccess(viewer, rules, facts)).toBe(expected);
  });
});
