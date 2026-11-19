import { randomBytes, randomUUID } from 'node:crypto';
import '../../src/common/config/load-env.js';

// Per-worker test environment: always target the TEST database and use throwaway secrets
// generated at runtime (never hardcoded; constitution Principle III).
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
process.env.OPS_TOKEN ||= `test-ops-${randomUUID()}`;
process.env.META_APP_ID ||= '1234567890';
process.env.META_APP_SECRET ||= `test-app-secret-${randomUUID()}`;
process.env.META_WEBHOOK_VERIFY_TOKEN ||= `test-verify-${randomUUID()}`;
process.env.META_GRAPH_BASE_URL = 'https://graph.facebook.test';
