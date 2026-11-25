// SC-004 check for store notifications (006 T089): 500 store order events, 100 of them repeats, give
// exactly one order confirmation per order, and 95% of the confirmations are queued for WhatsApp
// within 1 minute of their event reaching the platform.
// The run connects a Shopify store on mock-meta, turns on the order confirmation with an approved
// utility template of the number, posts 400 signed orders/create events to the platform's receiver,
// then 100 repeats (half with the same webhook id, as a Shopify retry, half with a new one, as a
// second topic for the same order), watches each order's notification in the store's orders list,
// and disconnects the store.
//
// Needs the api and the worker running with OUTBOUND_ALLOW_LOCAL=true (the store is on localhost),
// mock-meta, a seeded admin, and a connected number with an approved utility template (for example
// from perf:inbox-seed, after its templates are synced):
//   PERF_NUMBER_ID=<id> npm run perf:stores
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, PERF_MOCK_META_URL (default
//      http://localhost:4010), PERF_NUMBER_ID, PERF_ORDERS (default 400), PERF_REPEATS (default 100).
import { createHmac, randomUUID } from 'node:crypto';
import { ApiClient, formatDuration, perfEnv, report, run } from './client.js';

const ORDERS = Math.min(Number(process.env.PERF_ORDERS ?? 400), 999);
const REPEATS = Math.min(Number(process.env.PERF_REPEATS ?? 100), ORDERS);
const CONCURRENCY = 25;
const LIMIT_MS = 60_000;
const WAIT_MS = 300_000;

interface OrderRow {
  orderNumber: string;
  messages: Array<{ kind: string; outcome: string; skipReason: string | null }>;
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
  const numberId = process.env.PERF_NUMBER_ID;
  if (!numberId) throw new Error('Set PERF_NUMBER_ID to a connected number with an approved utility template');
  const api = await ApiClient.signIn(env);
  const numbers = await api.get<Array<{ id: string; wabaId: string }>>('/api/numbers');
  const number = numbers.find((n) => n.id === numberId);
  if (!number) throw new Error(`Number ${numberId} not found`);
  const templates = await api.get<Array<{ id: string; wabaId: string; category: string; variables: Array<{ key: string }> }>>('/api/templates?status=APPROVED');
  const template = templates.find((t) => t.wabaId === number.wabaId && t.category === 'UTILITY');
  if (!template) throw new Error('The number has no approved utility template; sync its templates first');

  const suffix = Date.now().toString().slice(-6);
  const clientSecret = `perf-store-secret-${randomUUID()}`;
  const store = await api.post<{ id: string }>('/api/stores', {
    platform: 'SHOPIFY',
    baseUrl: `${env.mockMetaUrl}/shopify/perf${suffix}`,
    numberId,
    defaultCountry: 'AE',
    customerTag: 'perf-store',
    credentials: { clientId: 'perf-client', clientSecret },
  });
  try {
    const variableMapping = Object.fromEntries(template.variables.map((v) => [v.key, { source: 'order', key: 'order_number' }]));
    await api.request('PUT', `/api/stores/${store.id}/automations/ORDER_CONFIRMED`, { json: { enabled: true, steps: [{ templateId: template.id, variableMapping }] } });

    const now = new Date().toISOString();
    const orders = Array.from({ length: ORDERS }, (_, i) => {
      const id = Number(`9${suffix}${String(i).padStart(3, '0')}`);
      return {
        webhookId: randomUUID(),
        orderNumber: `#P${suffix}${String(i).padStart(3, '0')}`,
        payload: {
          id,
          admin_graphql_api_id: `gid://shopify/Order/${id}`,
          name: `#P${suffix}${String(i).padStart(3, '0')}`,
          total_price: '25.00',
          currency: 'AED',
          financial_status: 'paid',
          created_at: now,
          updated_at: now,
          payment_gateway_names: ['shopify_payments'],
          shipping_address: { first_name: 'Perf', last_name: `Buyer ${i}`, phone: `+97155${suffix.slice(-4)}${String(i).padStart(3, '0')}` },
          line_items: [],
          fulfillments: [],
        },
      };
    });
    const postedAt = new Map<string, number>();
    const post = async (o: (typeof orders)[number], webhookId: string) => {
      const raw = JSON.stringify(o.payload);
      const res = await fetch(`${env.apiUrl}/api/integrations/shopify/${store.id}/webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': 'orders/create',
          'x-shopify-webhook-id': webhookId,
          'x-shopify-hmac-sha256': createHmac('sha256', clientSecret).update(raw).digest('base64'),
        },
        body: raw,
      });
      if (res.status !== 200) throw new Error(`The receiver answered ${res.status} for ${o.orderNumber}`);
    };
    const started = Date.now();
    await inParallel(orders, CONCURRENCY, async (o) => {
      postedAt.set(o.orderNumber, Date.now());
      await post(o, o.webhookId);
    });
    // Repeats: half as a retry of the same delivery, half as another delivery for the same order.
    const repeats = orders.slice(0, REPEATS);
    await inParallel(repeats, CONCURRENCY, async (o) => post(o, repeats.indexOf(o) % 2 === 0 ? o.webhookId : randomUUID()));
    console.log(`Posted ${orders.length + repeats.length} events in ${formatDuration(Date.now() - started)}`);

    const firstSeen = new Map<string, number>();
    let rows: OrderRow[] = [];
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      rows = [];
      for (let page = 1; page <= Math.ceil(ORDERS / 200) + 1; page += 1) {
        const batch = await api.get<{ items: OrderRow[] }>(`/api/stores/${store.id}/orders?page=${page}&pageSize=200`);
        rows.push(...batch.items);
        if (batch.items.length < 200) break;
      }
      const at = Date.now();
      for (const row of rows) {
        if (!firstSeen.has(row.orderNumber) && row.messages.some((m) => m.kind === 'ORDER_CONFIRMED')) firstSeen.set(row.orderNumber, at);
      }
      if (firstSeen.size >= ORDERS) break;
      await sleep(2_000);
    }

    const latencies = orders.filter((o) => firstSeen.has(o.orderNumber)).map((o) => firstSeen.get(o.orderNumber)! - postedAt.get(o.orderNumber)!);
    const confirmations = rows.map((r) => r.messages.filter((m) => m.kind === 'ORDER_CONFIRMED'));
    const twice = confirmations.filter((c) => c.length > 1).length;
    const queued = confirmations.filter((c) => c.length === 1 && c[0]!.outcome === 'QUEUED').length;
    const p95 = percentile(latencies, 0.95);
    report(`Store notifications (${ORDERS} orders, ${REPEATS} repeated events)`, [
      ['one order per order', rows.length === ORDERS, `${rows.length} orders for ${ORDERS}`],
      ['exactly one confirmation per order (SC-004)', twice === 0 && firstSeen.size === ORDERS, `${firstSeen.size} confirmed, ${twice} twice, ${queued} queued`],
      ['95% within 1 minute (SC-004)', latencies.length > 0 && p95 <= LIMIT_MS, `p95 ${formatDuration(p95)}, max ${formatDuration(Math.max(0, ...latencies))} (2-second polling)`],
    ]);
  } finally {
    await api.post(`/api/stores/${store.id}/disconnect`).catch(() => undefined);
  }
});
