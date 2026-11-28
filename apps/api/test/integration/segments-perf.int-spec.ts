import { Prisma } from '../../src/generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SegmentQueryBuilder } from '../../src/modules/contacts/segment-query.builder.js';
import { digits } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T004/T087 (feature 010, SC-001): the count of a 10-rule segment over 200,000 contacts appears within 3 seconds.
// Opt-in, because it seeds 200,000 rows: `npm run perf:segments -w @wbm/api` (PERF_SEGMENTS=1). CI runs it in
// the build-test job after the other tests; the plan is printed for the release checklist.
const RUN = process.env.PERF_SEGMENTS === '1';
const CONTACTS = Number(process.env.PERF_SEGMENT_CONTACTS ?? 200_000);
const LIMIT_MS = 3_000;

describe.skipIf(!RUN)('Segment counts over 200,000 contacts (010 SC-001)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  const marker = digits(4);
  const tags = { a: `perf-a-${marker}`, b: `perf-b-${marker}` };

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    const [a, b] = await Promise.all([ctx.prisma.tag.create({ data: { name: tags.a } }), ctx.prisma.tag.create({ data: { name: tags.b } })]);
    const started = Date.now();
    // Phones +9715 8 <marker> <6 digits> never collide with other tests' random UAE numbers of the same run.
    await ctx.prisma.$executeRaw`
      INSERT INTO contacts (id, phone_e164, country_code, name, attributes, consent_status, lead_source_kind, created_at, updated_at)
      SELECT gen_random_uuid(),
             '+9715' || ${'8' + marker} || lpad(i::text, 6, '0'),
             'AE',
             'Perf ' || i,
             jsonb_build_object('city', (ARRAY['Dubai', 'Sharjah', 'Abu Dhabi', 'Ajman'])[1 + i % 4], 'tier', i % 5, 'vip', i % 7 = 0,
                                'joined', to_char(date '2020-01-01' + (i % 1500), 'YYYY-MM-DD')),
             (CASE WHEN i % 10 = 0 THEN 'OPTED_OUT' WHEN i % 3 = 0 THEN 'UNKNOWN' ELSE 'OPTED_IN' END)::"ConsentStatus",
             (ARRAY['IMPORT', 'API', 'ORGANIC'])[1 + i % 3]::"LeadSourceKind",
             now() - (i % 365) * interval '1 day',
             now()
        FROM generate_series(1, ${CONTACTS}) AS i
      ON CONFLICT (phone_e164) DO NOTHING`;
    const prefix = `+97158${marker}%`;
    await ctx.prisma.$executeRaw`INSERT INTO contact_tags (contact_id, tag_id) SELECT id, ${a.id}::uuid FROM contacts WHERE phone_e164 LIKE ${prefix} AND abs(hashtext(id::text)) % 2 = 0`;
    await ctx.prisma.$executeRaw`INSERT INTO contact_tags (contact_id, tag_id) SELECT id, ${b.id}::uuid FROM contacts WHERE phone_e164 LIKE ${prefix} AND abs(hashtext(id::text)) % 5 = 0`;
    await ctx.prisma.$executeRaw`ANALYZE contacts`;
    await ctx.prisma.$executeRaw`ANALYZE contact_tags`;
    console.log(`[perf:segments] seeded ${CONTACTS} contacts with tags and attributes in ${Date.now() - started} ms`);
  }, 600_000);

  afterAll(async () => ctx.close());

  it('counts a 10-rule segment within 3 seconds', async () => {
    const rules = {
      groups: [
        {
          match: 'all',
          rules: [
            { kind: 'tag', tag: tags.a, has: true },
            { kind: 'tag', tag: tags.b, has: false },
            { kind: 'attr', attr: 'city', op: 'eq', value: 'Dubai' },
            { kind: 'attr', attr: 'tier', op: 'gt', value: 1 },
            { kind: 'attr', attr: 'joined', op: 'after', value: '2021-01-01' },
            { kind: 'consent', statuses: ['OPTED_IN', 'UNKNOWN'] },
            { kind: 'lead_source', sources: ['IMPORT', 'API'] },
            { kind: 'added', days: 300 },
            { kind: 'blocked', blocked: false },
            { kind: 'behaviour', event: 'delivered', did: false, days: 30 },
          ],
        },
      ],
    };
    for (const key of ['city', 'tier', 'joined']) {
      await ctx.prisma.attributeDefinition.upsert({ where: { key }, create: { key, label: key, type: key === 'tier' ? 'NUMBER' : key === 'joined' ? 'DATE' : 'TEXT' }, update: {} });
    }
    const created = await manager.agent.post('/api/segments').set('X-CSRF-Token', manager.csrf).send({ name: `Perf segment ${marker}`, rules });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const started = Date.now();
    const counted = await manager.agent.get(`/api/segments/${created.body.id}/count`);
    const ms = Date.now() - started;
    expect(counted.status).toBe(200);
    console.log(`[perf:segments] count=${counted.body.count} marketable=${counted.body.marketable} in ${ms} ms (limit ${LIMIT_MS} ms)`);
    // In CI the timing becomes a notice annotation, readable without the job log (release checklist, SC-001).
    if (process.env.GITHUB_ACTIONS) process.stdout.write(`::notice title=SC-001 segment count::${CONTACTS} contacts, 10 rules: ${ms} ms (limit ${LIMIT_MS} ms)
`);

    const builder = ctx.app.get(SegmentQueryBuilder);
    const compiled = await builder.compile(builder.parse(rules));
    const plan = await ctx.prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`EXPLAIN ANALYZE SELECT count(*) FROM contacts c WHERE ${compiled.where}`);
    console.log(`[perf:segments] plan:\n${plan.map((p) => p['QUERY PLAN']).join('\n')}`);
    expect(counted.body.count).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LIMIT_MS);
  }, 120_000);
});
