// Operator reset of one member's two-factor sign-in (feature 010 US6, contracts/login-2fa.md §6), for the only
// admin who lost both the phone and the recovery codes:
//   npm run auth:reset-2fa -w @wbm/api -- --email admin@company.com
// It deletes the member's secret and recovery codes, ends their sessions, clears the lock and writes an audit
// entry with the actor "operator". No secret or code is printed.
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import pg from 'pg';
import '../src/common/config/load-env.js';

const { values } = parseArgs({ options: { email: { type: 'string' } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run auth:reset-2fa -w @wbm/api -- --email <email>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let userId: string | null = null;
try {
  await client.query('BEGIN');
  const found = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  userId = found.rows[0]?.id ?? null;
  if (!userId) {
    await client.query('ROLLBACK');
    console.error(`No member with the email ${email}`);
    process.exit(1);
  }
  await client.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
  await client.query('DELETE FROM user_two_factor WHERE user_id = $1', [userId]);
  const sessions = await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await client.query(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata, ip, created_at)
     VALUES (gen_random_uuid(), NULL, 'auth.2fa_reset', 'user', $1, '{"by":"operator"}'::jsonb, NULL, now())`,
    [userId],
  );
  await client.query('COMMIT');
  console.log(`Two-factor sign-in reset for ${email}; ${sessions.rowCount ?? 0} session(s) ended.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error('Reset failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}

// The lock and failure counters live in Redis; clear them when Redis is reachable.
if (userId && process.env.REDIS_URL) {
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.del(`wbm:login2fa:fail:${userId}`, `wbm:login2fa:lock:${userId}`);
  } catch {
    console.warn('Redis was not reachable; a lock, if any, ends by itself within 15 minutes.');
  } finally {
    redis.disconnect();
  }
}
