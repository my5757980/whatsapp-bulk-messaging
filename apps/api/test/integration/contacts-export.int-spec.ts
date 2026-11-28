import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T033 (feature 010 US2, FR-013, research R6): the contacts export, streamed, audited and limited by role.
describe('Contacts export (010 US2)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  const tag = `exp-${digits(6)}`;
  const attr = `expcity${digits(5)}`;
  let tagId: string;

  const csv = async (query: Record<string, string>) => {
    const res = await manager.agent.get('/api/contacts/export.csv').query(query).buffer(true).parse((r, cb) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => (text += chunk));
      r.on('end', () => cb(null, text));
    });
    return { status: res.status, headers: res.headers, lines: String(res.body).trim().split('\n') };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    [manager, agent] = await Promise.all([signIn(ctx, 'MANAGER'), signIn(ctx, 'AGENT')]);
    await ctx.prisma.attributeDefinition.create({ data: { key: attr, label: 'City', type: 'TEXT' } });
    tagId = (await ctx.prisma.tag.create({ data: { name: tag } })).id;
    for (let i = 0; i < 5; i += 1) {
      const c = await seedContact(ctx, uaePhone(), { name: `Export ${i}`, attributes: { [attr]: i % 2 ? 'Dubai' : 'Sharjah' }, leadSourceKind: 'IMPORT', leadSource: 'Expo' });
      await ctx.prisma.contactTag.create({ data: { contactId: c.id, tagId } });
    }
  });
  afterAll(async () => ctx.close());

  it('streams one row per contact of a filter, with a column per attribute, and audits the download', async () => {
    const { status, headers, lines } = await csv({ tag });
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/text\/csv/);
    const header = lines[0]!.split(',');
    expect(header.slice(0, 3)).toEqual(['name', 'phone', 'tags']);
    expect(header).toContain(attr);
    expect(header.slice(-7)).toEqual(['consent_status', 'consent_source', 'consent_at', 'lead_source', 'lead_source_label', 'added_at', 'last_message_at']);
    expect(lines).toHaveLength(6);
    expect(lines.slice(1).every((l) => l.includes(',IMPORT,Expo,'))).toBe(true);
    const listed = await manager.agent.get('/api/contacts').query({ tag });
    expect(listed.body.page.total).toBe(5);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'data.exported', targetType: 'contacts' }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ selection: 'filter', rows: 5, format: 'csv' });
  });

  it('exports a segment, refuses a broken one, and is closed to roles without data.export', async () => {
    const seg = await manager.agent
      .post('/api/segments')
      .set('X-CSRF-Token', manager.csrf)
      .send({ name: `Export Dubai ${digits(6)}`, rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag, has: true }, { kind: 'attr', attr, op: 'eq', value: 'Dubai' }] }] } });
    expect(seg.status).toBe(201);
    expect((await csv({ segmentId: seg.body.id })).lines).toHaveLength(3);
    await ctx.prisma.attributeDefinition.delete({ where: { key: attr } });
    expect((await manager.agent.get('/api/contacts/export.csv').query({ segmentId: seg.body.id })).status).toBe(422);
    expect((await agent.agent.get('/api/contacts/export.csv').query({ tag })).status).toBe(403);
  });
});
