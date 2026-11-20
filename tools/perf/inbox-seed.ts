// SC-006 data for live chat (002 T101): 10,000 chats and one chat of 5,000 messages, created through
// the real inbound path (signed webhooks to the api, processed by the worker).
//
// Needs the api and the worker running (web and mock-meta are not needed), a seeded admin, and the
// api's META_APP_SECRET (from the environment or .env). Welcome and off-hours messages must be off,
// or the seed would answer every customer:
//   npm run perf:inbox-seed
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, META_APP_SECRET,
//      PERF_CHATS (default 10000), PERF_LONG_CHAT_MESSAGES (default 5000).
// Prints PERF_NUMBER_ID and PERF_LONG_CHAT_ID for `npm run perf:inbox`.
import { ApiClient, formatDuration, metaAppSecret, perfEnv, postInboundTexts, report, run, waitFor, type InboundText } from './client.js';

const CHATS = Number(process.env.PERF_CHATS ?? 10_000);
const LONG_CHAT_MESSAGES = Number(process.env.PERF_LONG_CHAT_MESSAGES ?? 5_000);
/** Customer messages per webhook, as Meta batches them under load. */
const PER_WEBHOOK = 50;
const SEED_LIMIT_MS = 45 * 60_000;

interface ListPage {
  items: Array<{ id: string; lastMessagePreview: string | null }>;
  counts: { ACTIVE: number; REQUESTING: number; INTERVENED: number; HISTORY: number };
}

async function inBatches(messages: InboundText[], send: (batch: InboundText[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < messages.length; i += PER_WEBHOOK) await send(messages.slice(i, i + PER_WEBHOOK));
}

run(async () => {
  const env = perfEnv();
  const secret = metaAppSecret();
  const api = await ApiClient.signIn(env);
  const settings = await api.get<{ welcomeEnabled: boolean; offHoursEnabled: boolean }>('/api/live-chat/settings');
  if (settings.welcomeEnabled || settings.offHoursEnabled) {
    throw new Error('Turn off the welcome and off-hours messages in Settings > Live chat before seeding');
  }

  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `60${suffix}`;
  const number = await api.post<{ id: string }>('/api/numbers', { label: `Inbox perf ${suffix}`, wabaId: `MOCK_WABA_I${suffix}`, phoneNumberId, accessToken: 'mock-token' });
  console.log(`Seeding ${CHATS} chats and one chat of ${LONG_CHAT_MESSAGES} messages on number ${number.id}`);
  const started = Date.now();

  // UAE mobile numbers +97154xxxxxxx, one per chat; the long chat uses +971559999999.
  const customers = Array.from({ length: CHATS }, (_, i) => ({ from: `+97154${String(i).padStart(7, '0')}`, name: `Perf customer ${i + 1}`, text: `Hello from customer ${i + 1}` }));
  await inBatches(customers, (batch) => postInboundTexts(env, secret, phoneNumberId, batch));
  const longFrom = '+971559999999';
  const endMarker = `perf-end-${suffix}`;
  const longMessages = Array.from({ length: LONG_CHAT_MESSAGES }, (_, i) => ({
    from: longFrom,
    name: 'Perf long chat',
    text: i === LONG_CHAT_MESSAGES - 1 ? endMarker : `Message ${i + 1} of a long conversation`,
  }));
  await inBatches(longMessages, (batch) => postInboundTexts(env, secret, phoneNumberId, batch));
  console.log(`Webhooks posted in ${formatDuration(Date.now() - started)}; waiting for the worker`);

  const total = await waitFor(
    `${CHATS + 1} chats`,
    async () => {
      const page = await api.get<ListPage>(`/api/inbox/conversations?numberId=${number.id}&view=live&limit=1`);
      const count = page.counts.ACTIVE + page.counts.REQUESTING + page.counts.INTERVENED + page.counts.HISTORY;
      return count >= CHATS + 1 ? count : undefined;
    },
    SEED_LIMIT_MS,
    5_000,
  );
  const longChat = await waitFor(
    'the last message of the long chat',
    async () => {
      const page = await api.get<ListPage>(`/api/inbox/conversations?numberId=${number.id}&view=live&limit=5&q=${encodeURIComponent(longFrom)}`);
      return page.items.find((c) => c.lastMessagePreview === endMarker);
    },
    SEED_LIMIT_MS,
    5_000,
  );

  report(`Live chat seed (${formatDuration(Date.now() - started)})`, [
    ['chats on the number', total >= CHATS + 1, String(total)],
    ['long chat complete', Boolean(longChat), longChat?.id ?? 'missing'],
  ]);
  console.log(`\nNext: PERF_NUMBER_ID=${number.id} PERF_LONG_CHAT_ID=${longChat.id} npm run perf:inbox`);
});
