import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedNumber, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T082 (feature 009 US8, research R16): the WhatsApp link and QR generator; nothing is stored.
describe('WhatsApp link generator (009 US8)', () => {
  let ctx: TestContext;
  let agent: SignedInAgent;

  const make = (body: object) => agent.agent.post('/api/tools/whatsapp-link').set('x-csrf-token', agent.csrf).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    agent = await signIn(ctx, 'AGENT');
    await setDefaultCountry(ctx, 'AE');
  });
  afterAll(async () => ctx.close());

  it('makes the link, a PNG data URL and an SVG, and stores nothing', async () => {
    const before = await ctx.prisma.chatLink.count();
    const res = await make({ phone: '050 123 4567', message: 'Hi, I saw your ad & want to know more' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.url).toBe(`https://wa.me/971501234567?text=${encodeURIComponent('Hi, I saw your ad & want to know more')}`);
    expect(res.body.qrPng).toMatch(/^data:image\/png;base64,/);
    expect(res.body.qrSvg).toMatch(/^<svg/);
    expect(res.body.connectedNumberId).toBeNull();
    expect((await make({ phone: '+971501234567' })).body.url).toBe('https://wa.me/971501234567');
    expect(await ctx.prisma.chatLink.count()).toBe(before);
  });

  it('refuses an invalid number, and names a connected number of the company', async () => {
    const bad = await make({ phone: '12345' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_NUMBER');
    const number = await seedNumber(ctx, { displayPhoneNumber: '+971 58 555 0199' });
    const res = await make({ phone: '+971585550199', message: 'Hello' });
    expect(res.body.connectedNumberId).toBe(number.id);
  });
});
