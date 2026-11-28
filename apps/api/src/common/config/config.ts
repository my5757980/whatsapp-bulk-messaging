import './load-env.js';
import { z } from 'zod';

// Every environment variable documented in .env.example, validated once at startup (T029).
// Invalid configuration fails fast with a readable message (constitution Principle III).

const base64Key32 = z
  .string()
  .min(1, 'is required')
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes encoded as base64');

const boolString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'is required'),
  /** Connections per process; the worker runs up to 50 sends and 10 webhook jobs in parallel. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('wbm'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: base64Key32,
  OPS_TOKEN: z.string().min(16, 'must be at least 16 characters'),
  COOKIE_SECURE: boolString,
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Feature 010 (US6): the issuer shown in authenticator apps. */
  APP_NAME: z.string().trim().min(1).max(60).default('WhatsApp Platform'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WORKER_PORT: z.coerce.number().int().positive().default(4001),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like v27.0')
    .default('v27.0'),
  /** Numeric Meta app id; needed for media template headers and carousel card samples (Resumable Upload API). */
  META_APP_ID: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^[0-9]+$/.test(v), 'must be the numeric Meta app id'),
  META_APP_SECRET: z.string().min(1, 'is required'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1, 'is required'),
  SMTP_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Browser push (VAPID) for live chat alerts: set all three or none (feature 002, FR-037). */
  WEB_PUSH_PUBLIC_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  WEB_PUSH_PRIVATE_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  WEB_PUSH_SUBJECT: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^(mailto:|https:\/\/)/.test(v), 'must start with mailto: or https://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** AI agent (feature 004): the company's Anthropic API key. Without it (and without a base URL) agents fail closed. */
  ANTHROPIC_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Points the Claude SDK at mock-meta's fake model in tests and local runs (contracts/claude-messages.md §7). */
  ANTHROPIC_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^https?:\/\//.test(v), 'must be an http(s) URL'),
  /** The Claude model for customer replies and the assistant (research R1). */
  AI_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  /**
   * Campaign growth (feature 005, research R1): the company's public address for tracked links,
   * for example https://go.company.example or https://wa.company.example/l. A link is
   * `${PUBLIC_LINK_BASE_URL}/<code>` and the api answers it at GET /l/:code. Without it links
   * cannot be tracked.
   */
  PUBLIC_LINK_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : undefined))
    .refine(
      (v) => v === undefined || /^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(v),
      'must be an http(s) address without a query or fragment',
    ),
  /** Integrations (feature 006, research R7): the Shopify Admin API version, upgraded on purpose. */
  SHOPIFY_API_VERSION: z
    .string()
    .trim()
    .regex(/^\d{4}-(01|04|07|10)$/, 'must look like 2026-10')
    .default('2026-10'),
  /**
   * Local runs and tests only (feature 006): lets webhook endpoints and stores use http://localhost.
   * Outbound requests are otherwise https-only and never reach private addresses. Refused in production.
   * Feature 009: campaign media addresses on http://localhost pass the launch check too.
   */
  OUTBOUND_ALLOW_LOCAL: boolString,
  /**
   * Ads (feature 007, research R11): Meta's free entry point window for chats from ads, shown in live
   * chat as information. It never changes what may be sent.
   */
  ADS_FREE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(72),
  /**
   * Templates (feature 009, research R8): how long after a Meta-applied time-to-live a sent message
   * without a delivered status is marked "not delivered in time", and how often the sweep runs. E2E
   * shortens both.
   */
  EXPIRED_SWEEP_GRACE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),
  EXPIRED_SWEEP_EVERY_SECONDS: z.coerce.number().int().min(5).max(3_600).default(300),
  /**
   * Payments (feature 008, research R1): Stripe's API address (mock-meta in local runs and e2e) and the
   * pinned API version, upgraded on purpose like META_GRAPH_API_VERSION. Stripe keys are entered on
   * Payments → Gateway and stored encrypted, never in the environment.
   */
  STRIPE_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .default('https://api.stripe.com')
    .transform((v) => v.replace(/\/+$/, '')),
  STRIPE_API_VERSION: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/, 'must look like 2026-09-30.endive')
    .default('2026-09-30.endive'),
}).superRefine((env, ctx) => {
  const pushKeys = [env.WEB_PUSH_PUBLIC_KEY, env.WEB_PUSH_PRIVATE_KEY, env.WEB_PUSH_SUBJECT].filter(Boolean).length;
  if (pushKeys > 0 && pushKeys < 3) {
    ctx.addIssue({ code: 'custom', path: ['WEB_PUSH_PUBLIC_KEY'], message: 'set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT together, or none' });
  }
  // Production session cookies must never travel over plain HTTP (T198).
  if (env.NODE_ENV !== 'production') return;
  if (!env.COOKIE_SECURE) ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must be "true" in production' });
  if (!env.APP_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must use https in production' });
  if (env.PUBLIC_LINK_BASE_URL && !env.PUBLIC_LINK_BASE_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_LINK_BASE_URL'], message: 'must use https in production' });
  }
  if (env.OUTBOUND_ALLOW_LOCAL) ctx.addIssue({ code: 'custom', path: ['OUTBOUND_ALLOW_LOCAL'], message: 'must not be "true" in production' });
});

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parses and validates the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Minimal Redis surface used for the startup policy check. */
export interface RedisConfigReader {
  config(subcommand: 'GET', parameter: string): Promise<unknown>;
}

/**
 * BullMQ requires `maxmemory-policy noeviction`; anything else can silently drop jobs (R6).
 * Refuses to start when the policy is readable and wrong. Managed Redis services that block
 * CONFIG cannot be verified, so that case is reported to the caller instead.
 */
export async function assertRedisNoEviction(redis: RedisConfigReader): Promise<'verified' | 'unverifiable'> {
  let reply: unknown;
  try {
    reply = await redis.config('GET', 'maxmemory-policy');
  } catch {
    return 'unverifiable';
  }
  const values = Array.isArray(reply) ? reply : [];
  const policy = typeof values[1] === 'string' ? values[1] : undefined;
  if (!policy) return 'unverifiable';
  if (policy !== 'noeviction') {
    throw new ConfigError(`Redis maxmemory-policy is "${policy}"; it must be "noeviction" for BullMQ.`);
  }
  return 'verified';
}
