import { fileURLToPath } from 'node:url';

// Load the repo-root .env when present (Node's built-in loader; no extra dependency).
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env file: rely on the process environment
}

const port = Number(process.env.MOCK_META_PORT ?? 4010);

export const env = {
  port,
  /** Where the inbound CLI reaches mock-meta to store customer media files. */
  baseUrl: process.env.MOCK_META_URL ?? `http://localhost:${port}`,
  appSecret: process.env.META_APP_SECRET ?? '',
  webhookTarget: process.env.MOCK_WEBHOOK_TARGET ?? 'http://localhost:4000/api/webhooks/meta',
  /** The only access token mock-meta accepts. */
  token: 'mock-token',
  /** Delay before new templates are approved. */
  templateApprovalMs: Number(process.env.MOCK_TEMPLATE_APPROVAL_MS ?? 10_000),
};
