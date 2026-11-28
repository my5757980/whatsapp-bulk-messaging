import { randomInt, randomUUID } from 'node:crypto';
import nock from 'nock';
import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { TestContext } from './test-context.js';

// Shared integration-test fixtures for US1+ (numbers, templates, contacts, campaigns, Meta mocks).

export const META_BASE = 'https://graph.facebook.test';
export const META_VERSION = 'v27.0';
export const NUMBER_TOKEN = 'number-access-token';

/** Blocks real network calls except the local test servers (supertest, MinIO). */
export function useNockLocalOnly(): void {
  nock.disableNetConnect();
  nock.enableNetConnect(/(127\.0\.0\.1|localhost|\[::1\])/);
}

export function restoreNetwork(): void {
  nock.cleanAll();
  nock.enableNetConnect();
}

export function digits(length = 12): string {
  let out = '';
  while (out.length < length) out += randomUUID().replace(/\D/g, '');
  return out.slice(0, length);
}

export async function setDefaultCountry(ctx: TestContext, country: string): Promise<void> {
  await ctx.prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, defaultCountryCode: country }, update: { defaultCountryCode: country } });
}

export async function seedNumber(ctx: TestContext, overrides: Partial<Prisma.WhatsAppNumberUncheckedCreateInput> = {}) {
  const cipher = new TokenCipher(process.env.TOKEN_ENCRYPTION_KEY as string);
  return ctx.prisma.whatsAppNumber.create({
    data: {
      label: 'Test number',
      wabaId: `WABA${digits(8)}`,
      phoneNumberId: digits(15),
      displayPhoneNumber: '+1 555 010 0001',
      verifiedName: 'Acme Test',
      qualityRating: 'GREEN',
      accessTokenEnc: cipher.encrypt(NUMBER_TOKEN),
      ...overrides,
    },
  });
}

export async function seedTemplate(ctx: TestContext, wabaId: string, overrides: Partial<Prisma.TemplateUncheckedCreateInput> = {}) {
  const components = (overrides.components as Prisma.InputJsonValue | undefined) ?? [{ type: 'BODY', text: 'Hi {{1}}, your order is ready.' }];
  return ctx.prisma.template.create({
    data: {
      wabaId,
      metaTemplateId: digits(10),
      name: `tpl_${digits(8)}`,
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components,
      variables: [{ key: 'BODY.1', example: 'Sara' }],
      ...overrides,
    },
  });
}

export async function seedContact(ctx: TestContext, phoneE164: string, overrides: Partial<Prisma.ContactUncheckedCreateInput> = {}) {
  return ctx.prisma.contact.create({
    data: { phoneE164, countryCode: 'AE', name: 'Test contact', consentStatus: 'OPTED_IN', consentSource: 'MANUAL', ...overrides },
  });
}

const UAE_MOBILE_PREFIXES = ['50', '52', '54', '55', '56', '58'];
const usedPhones = new Set<string>();

/** A UAE mobile number that libphonenumber accepts, never repeated in a file and spread over the mobile prefixes. */
export function uaePhone(): string {
  for (;;) {
    const phone = `+971${UAE_MOBILE_PREFIXES[randomInt(UAE_MOBILE_PREFIXES.length)]}${digits(7)}`;
    if (!usedPhones.has(phone)) {
      usedPhones.add(phone);
      return phone;
    }
  }
}

/** Creates a RUNNING campaign with PENDING messages for the given contacts (bypasses launch). */
export async function seedRunningCampaign(
  ctx: TestContext,
  args: { numberId: string; templateId: string; createdById: string; contacts: Array<{ id: string; phoneE164: string }>; state?: 'RUNNING' | 'PAUSED' },
) {
  const campaign = await ctx.prisma.campaign.create({
    data: {
      name: `Seeded ${digits(4)}`,
      numberId: args.numberId,
      templateId: args.templateId,
      state: args.state ?? 'RUNNING',
      audienceType: 'UPLOAD',
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
      launchedAt: new Date(),
      createdById: args.createdById,
    },
  });
  await ctx.prisma.message.createMany({
    data: args.contacts.map((c) => ({
      origin: 'CAMPAIGN' as const,
      campaignId: campaign.id,
      contactId: c.id,
      phoneE164: c.phoneE164,
      recipientCountry: 'AE',
      numberId: args.numberId,
      templateId: args.templateId,
      resolvedParams: { 'BODY.1': 'Friend' },
      status: 'PENDING' as const,
    })),
  });
  return campaign;
}

export interface SentCall {
  to: string;
  body: Record<string, unknown>;
}

/**
 * Mocks POST /{phoneNumberId}/messages once per recipient (E.164). Recipients ending in 0000 get
 * Meta error 131026; the others get `wamid.<digits>`. A second send to the same recipient finds
 * no interceptor, so duplicates surface as failures. Returns the matched calls.
 *
 * Static replies are used on purpose: nock 15 hangs native fetch when a reply is a function.
 */
export function mockMetaSends(phoneNumberId: string, recipients: string[], calls: SentCall[] = []): SentCall[] {
  for (const phone of recipients) {
    const to = phone.startsWith('+') ? phone.slice(1) : phone;
    const scope = nock(META_BASE).post(`/${META_VERSION}/${phoneNumberId}/messages`, (body: Record<string, unknown>) => {
      if (body.to !== to) return false;
      calls.push({ to, body });
      return true;
    });
    if (to.endsWith('0000')) {
      scope.reply(400, { error: { message: '(#131026) Message undeliverable', type: 'OAuthException', code: 131026, fbtrace_id: 'T' } });
    } else {
      scope.reply(200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.${to}` }] });
    }
  }
  return calls;
}

/** CSV upload helper for multipart endpoints. */
export function csvFile(rows: string[]): Buffer {
  return Buffer.from(`${rows.join('\n')}\n`, 'utf8');
}
