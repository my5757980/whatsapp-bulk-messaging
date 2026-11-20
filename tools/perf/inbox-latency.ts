// SC-006 and SC-001 checks for live chat (002 T101), on data from `npm run perf:inbox-seed`:
// - the live chat list and an open chat of 5,000 messages each load in under 2 seconds (p95)
// - a customer message reaches every open event stream in under 2 seconds (p95), with 20 streams
//   open (one per member online; all signed in as the perf admin)
//
// Needs the api and the worker running, a seeded admin and the api's META_APP_SECRET:
//   PERF_NUMBER_ID=<id> PERF_LONG_CHAT_ID=<id> npm run perf:inbox
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, META_APP_SECRET, PERF_NUMBER_ID,
//      PERF_LONG_CHAT_ID, PERF_STREAMS (default 20), PERF_SAMPLES (default 50).
import { ApiClient, metaAppSecret, p95, perfEnv, postInboundTexts, report, run } from './client.js';

const STREAMS = Number(process.env.PERF_STREAMS ?? 20);
const SAMPLES = Number(process.env.PERF_SAMPLES ?? 50);
const LOAD_TRIES = 20;
const LIMIT_MS = 2_000;
const EVENT_TIMEOUT_MS = 10_000;

/** One live event stream; calls `onText` with each new message's text and its arrival time. */
async function openStream(url: string, cookie: string, onText: (text: string, at: number) => void): Promise<AbortController> {
  const abort = new AbortController();
  const res = await fetch(url, { headers: { cookie, accept: 'text/event-stream' }, signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`Event stream -> ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!/^event: message\.created$/m.test(block)) continue;
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          const text = (JSON.parse(data) as { item?: { text?: string | null } }).item?.text;
          if (text) onText(text, Date.now());
        }
      }
    } catch {
      // Aborted at the end of the run.
    }
  })();
  return abort;
}

async function timed(task: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await task();
  return performance.now() - started;
}

run(async () => {
  const env = perfEnv();
  const numberId = process.env.PERF_NUMBER_ID;
  const longChatId = process.env.PERF_LONG_CHAT_ID;
  if (!numberId || !longChatId) throw new Error('Set PERF_NUMBER_ID and PERF_LONG_CHAT_ID (printed by npm run perf:inbox-seed)');
  const secret = metaAppSecret();
  const api = await ApiClient.signIn(env);
  const number = await api.get<Array<{ id: string; phoneNumberId: string }>>('/api/numbers').then((all) => all.find((n) => n.id === numberId));
  if (!number) throw new Error(`Number ${numberId} not found`);

  // SC-006: list and open-chat times.
  const list: number[] = [];
  const open: number[] = [];
  for (let i = 0; i < LOAD_TRIES; i += 1) {
    list.push(await timed(() => api.get('/api/inbox/conversations?view=live&limit=30')));
    open.push(await timed(() => Promise.all([api.get(`/api/inbox/conversations/${longChatId}`), api.get(`/api/inbox/conversations/${longChatId}/items?limit=50`)])));
  }

  // SC-001: customer message → every open stream.
  const arrivals = new Map<string, number[]>();
  const streams = await Promise.all(
    Array.from({ length: STREAMS }, () =>
      openStream(`${env.apiUrl}/api/inbox/events`, api.cookieHeader(), (text, at) => {
        arrivals.get(text)?.push(at);
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // let every stream attach
  const lags: number[] = [];
  let missing = 0;
  const suffix = Date.now().toString().slice(-6);
  for (let i = 0; i < SAMPLES; i += 1) {
    const marker = `perf-lag-${suffix}-${i}`;
    arrivals.set(marker, []);
    const sentAt = Date.now();
    await postInboundTexts(env, secret, number.phoneNumberId, [{ from: `+97156${suffix.slice(-3)}${String(i).padStart(4, '0')}`, name: 'Perf latency', text: marker }]);
    const deadline = sentAt + EVENT_TIMEOUT_MS;
    while ((arrivals.get(marker)?.length ?? 0) < STREAMS && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const got = arrivals.get(marker) ?? [];
    missing += STREAMS - got.length;
    lags.push(...got.map((at) => at - sentAt));
  }
  for (const stream of streams) stream.abort();

  report('Live chat performance (SC-006, SC-001)', [
    ['list p95', p95(list) < LIMIT_MS, `${Math.round(p95(list))} ms over ${LOAD_TRIES} loads`],
    ['open chat p95 (5,000 messages)', p95(open) < LIMIT_MS, `${Math.round(p95(open))} ms over ${LOAD_TRIES} loads`],
    ['message to stream p95', lags.length > 0 && p95(lags) < LIMIT_MS, `${Math.round(p95(lags))} ms over ${lags.length} deliveries to ${STREAMS} streams`],
    ['every stream got every message', missing === 0, `${missing} missing`],
  ]);
});
