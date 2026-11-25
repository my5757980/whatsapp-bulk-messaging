// SC-001 check for outbound webhooks (006 T089): for a healthy endpoint, 99% of events are delivered
// within 10 seconds of happening. The run adds an endpoint on mock-meta's request catcher for
// contact.created, creates PERF_EVENTS contacts in parallel, reads what the catcher received, and
// measures each event from happening (the payload timestamp) to arriving. It then removes the
// endpoint and the contacts it made.
//
// Needs the api and the worker running with OUTBOUND_ALLOW_LOCAL=true (the catcher is on localhost),
// mock-meta, and a seeded admin:
//   npm run perf:webhooks
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, PERF_MOCK_META_URL (default
//      http://localhost:4010), PERF_EVENTS (default 500), PERF_CONCURRENCY (default 20).
import { ApiClient, formatDuration, perfEnv, report, run } from './client.js';

const EVENTS = Math.min(Number(process.env.PERF_EVENTS ?? 500), 999);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 20);
const LIMIT_MS = 10_000;
const WAIT_MS = 120_000;

interface Caught {
  headers: Record<string, string>;
  body: string;
  receivedAt: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

run(async () => {
  const env = perfEnv();
  const api = await ApiClient.signIn(env);
  const suffix = Date.now().toString().slice(-6);
  const catcher = `perf-webhooks-${suffix}`;
  const caught = async () => ((await (await fetch(`${env.mockMetaUrl}/catch/${catcher}`)).json()) as { requests: Caught[] }).requests;
  await fetch(`${env.mockMetaUrl}/catch/${catcher}`, { method: 'DELETE' });

  const endpoint = await api.post<{ id: string }>('/api/webhook-endpoints', { name: `Perf ${suffix}`, url: `${env.mockMetaUrl}/catch/${catcher}`, eventTypes: ['contact.created'] });
  // The worker sees a new endpoint within a second (research R2).
  await sleep(2_000);

  const contactIds: string[] = [];
  try {
    const phones = Array.from({ length: EVENTS }, (_, i) => `+97156${suffix.slice(-4)}${String(i).padStart(3, '0')}`);
    const started = Date.now();
    await inParallel(phones, CONCURRENCY, async (phone) => {
      const contact = await api.post<{ id: string }>('/api/contacts', { phone, name: `Perf webhook ${phone.slice(-3)}` });
      contactIds.push(contact.id);
    });
    console.log(`Created ${contactIds.length} contacts in ${formatDuration(Date.now() - started)}`);

    const deadline = Date.now() + WAIT_MS;
    let requests = await caught();
    while (requests.length < contactIds.length && Date.now() < deadline) {
      await sleep(2_000);
      requests = await caught();
    }

    const ours = new Set(contactIds);
    const latencies: number[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const r of requests) {
      const payload = JSON.parse(r.body) as { type: string; timestamp: string; data: { contact?: { id?: string } } };
      if (payload.type !== 'contact.created' || !ours.has(payload.data.contact?.id ?? '')) continue;
      const id = r.headers['webhook-id'] ?? '';
      if (seen.has(id)) {
        duplicates += 1;
        continue;
      }
      seen.add(id);
      latencies.push(Date.parse(r.receivedAt) - Date.parse(payload.timestamp));
    }
    const p99 = percentile(latencies, 0.99);
    report(`Webhook delivery latency (${contactIds.length} contact.created events)`, [
      ['every event arrived', seen.size === contactIds.length, `${seen.size} of ${contactIds.length}`],
      ['99% within 10 s (SC-001)', latencies.length > 0 && p99 <= LIMIT_MS, `p99 ${formatDuration(p99)}, p50 ${formatDuration(percentile(latencies, 0.5))}, max ${formatDuration(Math.max(0, ...latencies))}`],
      ['no event delivered twice', duplicates === 0, `${duplicates} repeats`],
    ]);
  } finally {
    await api.request('DELETE', `/api/webhook-endpoints/${endpoint.id}`).catch(() => undefined);
    await inParallel(contactIds, CONCURRENCY, async (id) => {
      await api.request('DELETE', `/api/contacts/${id}`).catch(() => undefined);
    });
    await fetch(`${env.mockMetaUrl}/catch/${catcher}`, { method: 'DELETE' }).catch(() => undefined);
  }
});
