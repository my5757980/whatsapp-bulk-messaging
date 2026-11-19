// Dev helper (002 T054, quickstart US3): moves a chat back in time so Past chats, the window
// countdown and auto-resolve can be tried locally without waiting 24 hours.
//   npm run inbox:age -- --phone +971500000002 --hours 25
// It refuses to run with NODE_ENV=production.
import { parseArgs } from 'node:util';
import pg from 'pg';
import '../src/common/config/load-env.js';

if (process.env.NODE_ENV === 'production') {
  console.error('inbox:age refuses to run with NODE_ENV=production');
  process.exit(1);
}

const { values } = parseArgs({ options: { phone: { type: 'string' }, hours: { type: 'string', default: '25' } } });
const hours = Number(values.hours);
if (!values.phone || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
  console.error('Usage: npm run inbox:age -- --phone <E.164 phone> [--hours 25]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const chats = await client.query<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.phone_e164 = $1`,
    [values.phone],
  );
  const ids = chats.rows.map((r) => r.id);
  if (!ids.length) {
    console.error(`No chat found for ${values.phone}`);
    await client.query('ROLLBACK');
    process.exit(1);
  }
  const shift = `make_interval(hours => $2::int)`;
  await client.query(
    `UPDATE conversations SET last_customer_message_at = last_customer_message_at - ${shift}, last_inbound_at = last_inbound_at - ${shift},
            last_activity_at = last_activity_at - ${shift}, intervened_at = intervened_at - ${shift}, updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids, Math.round(hours)],
  );
  await client.query(`UPDATE chat_messages SET occurred_at = occurred_at - ${shift} WHERE conversation_id = ANY($1::uuid[])`, [ids, Math.round(hours)]);
  await client.query(`UPDATE conversation_openings SET opened_at = opened_at - ${shift} WHERE conversation_id = ANY($1::uuid[])`, [ids, Math.round(hours)]);
  await client.query('COMMIT');
  console.log(`Moved ${ids.length} chat(s) for ${values.phone} back by ${Math.round(hours)} hours`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
