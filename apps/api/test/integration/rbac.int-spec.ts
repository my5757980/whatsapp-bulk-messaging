import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { can, type Permission } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T167, T097, 003 T086: every operation's `x-permission` in the dashboard (001), live chat (002) and
// flows (003) contracts is enforced for each role (001 FR-007, 002 FR-041, 003 FR-038).
const SPECS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../specs');
const CONTRACTS = [
  path.join(SPECS, '001-whatsapp-bulk-messaging/contracts/dashboard-api.openapi.yaml'),
  path.join(SPECS, '002-team-inbox/contracts/inbox-api.openapi.yaml'),
  path.join(SPECS, '003-chatbot-flow-builder/contracts/flows-api.openapi.yaml'),
];
/** The live event stream never ends, so a plain request would hang; inbox-realtime.int-spec.ts covers it. */
const SKIP = new Set(['get /inbox/events']);
const ROLES = ['ADMIN', 'MANAGER', 'AGENT'] as const;
/** Documented operations that are not implemented yet (none since US7). */
const NOT_YET = new Set<string>();
const DUMMY_ID = '0190a000-0000-7000-8000-000000000000';

interface Operation {
  method: string;
  route: string;
  permission: Permission;
}

describe('Role permissions on every endpoint', () => {
  let ctx: TestContext;
  const agents = {} as Record<(typeof ROLES)[number], SignedInAgent>;
  const operations: Operation[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly(); // e.g. template sync must not reach the internet
    for (const role of ROLES) agents[role] = await signIn(ctx, role);
    for (const contract of CONTRACTS) {
      const doc = (await SwaggerParser.parse(contract)) as unknown as { paths: Record<string, Record<string, { 'x-permission'?: Permission }>> };
      operations.push(
        ...Object.entries(doc.paths).flatMap(([route, ops]) =>
          Object.entries(ops)
            .filter(([method, op]) => op && typeof op === 'object' && op['x-permission'] && !NOT_YET.has(route) && !SKIP.has(`${method} ${route}`))
            .map(([method, op]) => ({ method, route, permission: op['x-permission'] as Permission })),
        ),
      );
    }
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('covers the documented operations', () => {
    expect(operations.length).toBeGreaterThan(50);
    // Live chat operations are included (002 FR-041).
    expect(operations.some((op) => op.route === '/inbox/team-metrics')).toBe(true);
    // Flow builder operations too (003 T086).
    expect(operations.some((op) => op.route === '/flows/{id}/publish')).toBe(true);
  });

  it.each(ROLES)('%s gets 403 exactly where the role table says so', async (role) => {
    const who = agents[role];
    const mismatches: string[] = [];
    for (const op of operations) {
      const url = `/api${op.route.replace(/\{id\}/g, DUMMY_ID)}`;
      const method = op.method as 'get' | 'post' | 'put' | 'patch' | 'delete';
      let req = who.agent[method](url);
      if (method !== 'get') req = req.set('x-csrf-token', who.csrf).send({});
      const res = await req;
      const allowed = can(role, op.permission);
      if (allowed ? res.status === 403 : res.status !== 403) {
        mismatches.push(`${op.method.toUpperCase()} ${op.route} (${op.permission}) -> ${res.status}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
