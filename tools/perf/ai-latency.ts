// SC-001 check for AI agents (004 T109): with 50 customers writing at the same moment, each AI reply
// is queued for WhatsApp within 10 seconds of the customer's message reaching the platform (p95).
// It runs against the fake model (mock-meta's /anthropic), so it measures the platform: the debounce,
// the queue, knowledge, the reply checks and sending, not the AI service's own time.
// The run publishes an agent with one written answer on the number, sends rounds of 50 customer
// questions in one webhook each, matches each reply to its chat on the live event stream, then takes
// the number off the agent and unpublishes it.
//
// Needs the api and the worker running with ANTHROPIC_BASE_URL pointing at mock-meta, a seeded admin
// and the api's META_APP_SECRET. Use a number no other agent needs (for example from perf:inbox-seed):
//   PERF_NUMBER_ID=<id> npm run perf:ai
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, META_APP_SECRET, PERF_NUMBER_ID,
//      PERF_MOCK_META_URL (default http://localhost:4010), PERF_CUSTOMERS (default 50), PERF_ROUNDS (default 3).
import { ApiClient, metaAppSecret, openStream, p95, perfEnv, postInboundTexts, report, run } from './client.js';

const CUSTOMERS = Number(process.env.PERF_CUSTOMERS ?? 50);
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3);
const LIMIT_MS = 10_000;
const REPLY_TIMEOUT_MS = 30_000;
const ANSWER = 'Perf answer: we deliver across the UAE within two days.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

run(async () => {
  const env = perfEnv();
  const numberId = process.env.PERF_NUMBER_ID;
  if (!numberId) throw new Error('Set PERF_NUMBER_ID to a connected number (for example one from npm run perf:inbox-seed)');
  const secret = metaAppSecret();
  const api = await ApiClient.signIn(env);
  const number = await api.get<Array<{ id: string; phoneNumberId: string }>>('/api/numbers').then((all) => all.find((n) => n.id === numberId));
  if (!number) throw new Error(`Number ${numberId} not found`);

  // No scripted rules: the fake model answers with the written answer that shares words with the question.
  const rules = await fetch(`${env.mockMetaUrl}/mock/ai/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
  if (!rules.ok) throw new Error(`The fake model at ${env.mockMetaUrl} did not answer (${rules.status})`);

  const suffix = Date.now().toString().slice(-6);
  const agent = await api.post<{ id: string; config: Record<string, unknown> }>('/api/ai-agents', { name: `Perf agent ${suffix}` });
  await api.post(`/api/ai-agents/${agent.id}/knowledge/answers`, { question: 'Do you deliver across the UAE?', answer: ANSWER });
  await api.request('PUT', `/api/ai-agents/${agent.id}/draft`, { json: { config: { ...agent.config, goal: 'Answer questions about delivery.' }, draftRevision: 0 } });
  await api.post(`/api/ai-agents/${agent.id}/publish`);
  await api.request('PUT', `/api/ai-agents/${agent.id}/numbers`, { json: { numberIds: [number.id], replace: true } });

  // Each question names its customer, so the chat it opened is known; the reply is matched by chat.
  const questionOf = new Map<string, string>();
  const repliedAt = new Map<string, number>();
  const stream = await openStream(`${env.apiUrl}/api/inbox/events`, api.cookieHeader(), (text, at, data) => {
    if (!data.conversationId) return;
    if (text.startsWith('Perf question ')) questionOf.set(data.conversationId, text);
    else if (text.includes(ANSWER) && !repliedAt.has(data.conversationId)) repliedAt.set(data.conversationId, at);
  });
  await sleep(1_000); // let the stream attach

  const lags: number[] = [];
  let missing = 0;
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const customers = Array.from({ length: CUSTOMERS }, (_, i) => `+97158${suffix.slice(-3)}${round}${String(i).padStart(3, '0')}`);
      const question = (phone: string) => `Perf question ${phone}: do you deliver across the UAE?`;
      const expected = new Set(customers.map(question));
      const chats = () => [...questionOf.entries()].filter(([, text]) => expected.has(text)).map(([chatId]) => chatId);
      const sentAt = Date.now();
      await postInboundTexts(
        env,
        secret,
        number.phoneNumberId,
        customers.map((from, i) => ({ from, name: `Perf customer ${i}`, text: question(from) })),
      );
      const deadline = sentAt + REPLY_TIMEOUT_MS;
      while ((chats().length < CUSTOMERS || chats().some((chatId) => !repliedAt.has(chatId))) && Date.now() < deadline) await sleep(50);
      const seen = chats();
      missing += CUSTOMERS - seen.length;
      for (const chatId of seen) {
        const at = repliedAt.get(chatId);
        if (at === undefined) missing += 1;
        else lags.push(at - sentAt);
      }
    }
  } finally {
    stream.abort();
    await api.request('PUT', `/api/ai-agents/${agent.id}/numbers`, { json: { numberIds: [] } }).catch(() => undefined);
    await api.post(`/api/ai-agents/${agent.id}/unpublish`).catch(() => undefined);
  }

  report('AI agent performance (SC-001)', [
    [`AI reply queued p95 (${CUSTOMERS} customers at once)`, lags.length > 0 && p95(lags) <= LIMIT_MS, `${Math.round(p95(lags))} ms over ${lags.length} replies in ${ROUNDS} rounds`],
    ['every customer got a reply', missing === 0, `${missing} missing`],
  ]);
});
