import { createHmac, randomUUID } from 'node:crypto';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../src/common/queue/processor.registry.js';
import { WorkerFeaturesModule } from '../../src/worker-features.module.js';

/** Registry stub: worker services are wired, but no BullMQ Worker starts, so tests drive processors directly. */
const registryStub: Pick<ProcessorRegistry, 'register' | 'registerHandler' | 'stop' | 'isRunning'> = {
  register: () => undefined,
  registerHandler: () => undefined,
  stop: async () => undefined,
  isRunning: () => false,
};

@Global()
@Module({ providers: [{ provide: ProcessorRegistry, useValue: registryStub }], exports: [ProcessorRegistry] })
class StubRuntimeModule {}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  server: () => ReturnType<INestApplication['getHttpServer']>;
  close: () => Promise<void>;
}

/**
 * HTTP app + worker-side services in one process (processors are called directly by tests).
 * `overrides` replaces providers, e.g. a fake mailer.
 */
export async function createTestContext(overrides: Array<[token: unknown, value: unknown]> = []): Promise<TestContext> {
  let builder = Test.createTestingModule({
    imports: [AppModule, StubRuntimeModule, WorkerFeaturesModule],
  });
  for (const [token, value] of overrides) builder = builder.overrideProvider(token as never).useValue(value);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    server: () => app.getHttpServer(),
    close: () => app.close(),
  };
}

export const TEST_PASSWORD = 'Correct-Horse-Battery-12'; // gitleaks:allow - test-only password

export interface SignedInAgent {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  userId: string;
}

/** Creates an ACTIVE user with the role and signs in; returns a cookie-keeping agent + CSRF token. */
export async function signIn(ctx: TestContext, role: 'ADMIN' | 'MANAGER' | 'AGENT'): Promise<SignedInAgent> {
  const email = `${role.toLowerCase()}-${randomUUID()}@test.local`;
  const user = await ctx.prisma.user.create({
    data: { email, name: `${role} user`, role, status: 'ACTIVE', passwordHash: await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }) },
  });
  const agent = request.agent(ctx.server());
  const res = await agent.post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('csrf='));
  const csrf = decodeURIComponent(raw!.split(';')[0]!.slice('csrf='.length));
  return { agent, csrf, userId: user.id };
}

/** Posts a Meta-signed webhook payload; returns the stored webhook_events id. */
export async function postSignedWebhook(ctx: TestContext, payload: unknown): Promise<string> {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', process.env.META_APP_SECRET as string).update(raw).digest('hex')}`;
  const res = await request(ctx.server())
    .post('/api/webhooks/meta')
    .set('content-type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(raw);
  if (res.status !== 200) throw new Error(`webhook rejected: ${res.status}`);
  const event = await ctx.prisma.webhookEvent.findFirstOrThrow({ where: { signatureValid: true }, orderBy: { receivedAt: 'desc' } });
  return event.id;
}

export function uniq(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** Meta webhook envelope helpers (contracts/meta-webhooks.md). */
export const webhook = {
  status(phoneNumberId: string, wamid: string, recipient: string, status: string, extra: Record<string, unknown> = {}) {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient, ...extra }] } }] }],
    };
  },
  templateStatus(wabaId: string, templateId: string, name: string, language: string, event: string, reason = 'NONE') {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: wabaId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'message_template_status_update',
              value: { event, message_template_id: templateId, message_template_name: name, message_template_language: language, reason },
            },
          ],
        },
      ],
    };
  },
  inbound(phoneNumberId: string, from: string, text: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    };
  },
};
