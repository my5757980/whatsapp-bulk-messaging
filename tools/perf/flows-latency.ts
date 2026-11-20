// SC-001 check for chatbot flows (003 T087): with 20 customers writing at the same moment, each flow
// reply is queued for WhatsApp within 3 seconds of the customer's message reaching the platform (p95).
// The run publishes a one-step flow with its own keyword, sends rounds of 20 customer messages in one
// webhook each, times the replies on the live event stream, then unpublishes the flow.
//
// Needs the api and the worker running, a seeded admin and the api's META_APP_SECRET:
//   PERF_NUMBER_ID=<id> npm run perf:flows
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, META_APP_SECRET, PERF_NUMBER_ID,
//      PERF_CUSTOMERS (default 20), PERF_ROUNDS (default 5).
import { ApiClient, metaAppSecret, openStream, p95, perfEnv, postInboundTexts, report, run } from './client.js';

const CUSTOMERS = Number(process.env.PERF_CUSTOMERS ?? 20);
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 5);
const LIMIT_MS = 3_000;
const REPLY_TIMEOUT_MS = 15_000;

run(async () => {
  const env = perfEnv();
  const numberId = process.env.PERF_NUMBER_ID;
  if (!numberId) throw new Error('Set PERF_NUMBER_ID to a connected number (for example one from npm run perf:inbox-seed)');
  const secret = metaAppSecret();
  const api = await ApiClient.signIn(env);
  const number = await api.get<Array<{ id: string; phoneNumberId: string }>>('/api/numbers').then((all) => all.find((n) => n.id === numberId));
  if (!number) throw new Error(`Number ${numberId} not found`);

  const suffix = Date.now().toString().slice(-6);
  const keyword = `perfflow${suffix}`;
  const flow = await api.post<{ id: string }>('/api/flows', { name: `Perf flow ${suffix}` });
  const graph = {
    version: 1,
    start: 'reply',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [{ id: 'reply', type: 'message', text: 'Perf reply {phone}', next: null }],
  };
  await api.request('PUT', `/api/flows/${flow.id}/draft`, { json: { graph, draftRevision: 0 } });
  await api.post(`/api/flows/${flow.id}/publish`);

  // Each reply names its customer's phone, so its arrival can be matched to the message that caused it.
  const arrivals = new Map<string, number>();
  const stream = await openStream(`${env.apiUrl}/api/inbox/events`, api.cookieHeader(), (text, at) => {
    if (text.startsWith('Perf reply ') && !arrivals.has(text)) arrivals.set(text, at);
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // let the stream attach

  const lags: number[] = [];
  let missing = 0;
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const customers = Array.from({ length: CUSTOMERS }, (_, i) => `+97157${suffix.slice(-3)}${round}${String(i).padStart(3, '0')}`);
      const sentAt = Date.now();
      await postInboundTexts(
        env,
        secret,
        number.phoneNumberId,
        customers.map((from, i) => ({ from, name: `Perf customer ${i}`, text: keyword })),
      );
      const deadline = sentAt + REPLY_TIMEOUT_MS;
      const expected = customers.map((phone) => `Perf reply ${phone}`);
      while (expected.some((text) => !arrivals.has(text)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      for (const text of expected) {
        const at = arrivals.get(text);
        if (at === undefined) missing += 1;
        else lags.push(at - sentAt);
      }
    }
  } finally {
    stream.abort();
    await api.post(`/api/flows/${flow.id}/unpublish`).catch(() => undefined);
  }

  report('Chatbot flow performance (SC-001)', [
    [`reply queued p95 (${CUSTOMERS} customers at once)`, lags.length > 0 && p95(lags) <= LIMIT_MS, `${Math.round(p95(lags))} ms over ${lags.length} replies in ${ROUNDS} rounds`],
    ['every customer got a reply', missing === 0, `${missing} missing`],
  ]);
});
