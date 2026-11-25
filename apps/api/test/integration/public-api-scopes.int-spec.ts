import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { API_KEY_SCOPES, type ApiKeyScope } from '@wbm/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreNetwork, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T088 (feature 006, FR-015): every operation of the public API v1 contract names its key permission
// in `x-scope`; a key without that permission gets 403 insufficient_scope, and a key with only that
// permission gets past the check.
const CONTRACT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../specs/006-integrations-platform/contracts/public-api-v1.openapi.yaml');
const DUMMY_ID = '0190a000-0000-7000-8000-000000000000';

interface Operation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  route: string;
  scope: ApiKeyScope;
}

describe('Public API key permissions on every operation (006)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const operations: Operation[] = [];
  const keys = { with: new Map<ApiKeyScope, string>(), without: new Map<ApiKeyScope, string>() };

  const newKey = async (scopes: ApiKeyScope[]) => {
    const created = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Scopes '), rateLimitPerMinute: 600 });
    expect(created.status).toBe(201);
    expect((await admin.agent.put(`/api/api-keys/${String(created.body.id)}/scopes`).set('X-CSRF-Token', admin.csrf).send({ scopes })).status).toBe(200);
    return created.body.secret as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    const doc = (await SwaggerParser.parse(CONTRACT)) as unknown as { paths: Record<string, Record<string, { 'x-scope'?: ApiKeyScope }>> };
    for (const [route, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!op || typeof op !== 'object' || !['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        operations.push({ method: method as Operation['method'], route, scope: op['x-scope'] as ApiKeyScope });
      }
    }
    for (const scope of API_KEY_SCOPES) {
      keys.with.set(scope, await newKey([scope]));
      keys.without.set(scope, await newKey(API_KEY_SCOPES.filter((s) => s !== scope)));
    }
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('covers every documented operation, each with a known permission', () => {
    expect(operations.length).toBeGreaterThanOrEqual(14);
    for (const op of operations) expect(API_KEY_SCOPES, `${op.method} ${op.route}`).toContain(op.scope);
    expect(operations.some((op) => op.route === '/api-campaigns/{apiName}/messages' && op.scope === 'campaigns.trigger')).toBe(true);
  });

  it('answers 403 insufficient_scope without the permission, and gets past the check with it', async () => {
    const mismatches: string[] = [];
    for (const op of operations) {
      const url = `/api/v1${op.route.replace(/\{[^}]+\}/g, DUMMY_ID)}`;
      const call = (key: string) => {
        const req = request(ctx.server())[op.method](url).set('Authorization', `Bearer ${key}`);
        return op.method === 'get' || op.method === 'delete' ? req : req.send({});
      };
      const without = await call(keys.without.get(op.scope)!);
      if (without.status !== 403 || without.body.code !== 'insufficient_scope') mismatches.push(`${op.method} ${op.route} without ${op.scope} -> ${without.status}`);
      const withScope = await call(keys.with.get(op.scope)!);
      if (withScope.status === 403 || withScope.status === 401) mismatches.push(`${op.method} ${op.route} with ${op.scope} -> ${withScope.status}`);
    }
    expect(mismatches).toEqual([]);
  });
});
