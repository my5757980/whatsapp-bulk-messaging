// SC-002 performance check (T196): a 10,000-recipient campaign against tools/mock-meta finishes
// within 20 minutes at the number's configured send rate, with no recipient sent twice.
//
// Needs the api, the worker and mock-meta running (web is not needed), plus a seeded admin:
//   npm run perf:campaign
// Env: PERF_API_URL, PERF_MOCK_META_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD,
//      PERF_RECIPIENTS (default 10000), PERF_SEND_RATE (messages per second, default 80).
import { ApiClient, csvPart, formatDuration, perfEnv, report, run, waitFor } from './client.js';

const RECIPIENTS = Number(process.env.PERF_RECIPIENTS ?? 10_000);
const SEND_RATE = Number(process.env.PERF_SEND_RATE ?? 80);
const LIMIT_MS = 20 * 60_000;

interface CampaignView {
  state: string;
  pausedReasonText?: string | null;
  totals: Record<string, number>;
  launchedAt: string | null;
  completedAt: string | null;
}

run(async () => {
  const env = perfEnv();
  const api = await ApiClient.signIn(env);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `50${suffix}`;
  console.log(`Campaign of ${RECIPIENTS} recipients at ${SEND_RATE} msg/s (limit ${formatDuration(LIMIT_MS)})`);

  const number = await api.post<{ id: string; wabaId: string }>('/api/numbers', {
    label: `Perf ${suffix}`,
    wabaId: `MOCK_WABA_P${suffix}`,
    phoneNumberId,
    accessToken: 'mock-token',
  });
  await api.patch(`/api/numbers/${number.id}`, { sendRatePerSecond: SEND_RATE });
  await api.post('/api/templates/sync');
  const templates = await api.get<Array<{ id: string; name: string }>>(`/api/templates?wabaId=${number.wabaId}&status=APPROVED`);
  const template = templates.find((t) => t.name === 'order_confirmation');
  if (!template) throw new Error('Template order_confirmation not found - is mock-meta running?');
  const campaign = await api.post<{ id: string }>('/api/campaigns', {
    name: `Perf ${RECIPIENTS} ${suffix}`,
    numberId: number.id,
    templateId: template.id,
    audienceType: 'UPLOAD',
  });

  // UAE mobile numbers +97152xxxxxxx; mock-meta fails recipients ending in 0000 (realistic noise).
  const rows = ['name,phone', ...Array.from({ length: RECIPIENTS }, (_, i) => `Customer ${i + 1},+97152${String(i).padStart(7, '0')}`)];
  const form = new FormData();
  form.set('file', csvPart(rows), 'perf-campaign.csv');
  form.set('phoneColumn', 'phone');
  form.set('nameColumn', 'name');
  form.set('optInConfirmed', 'true');
  form.set('optInSourceNote', 'Performance test list');
  const upload = await api.upload<{ id: string }>(`/api/campaigns/${campaign.id}/audience-upload`, form);
  await waitFor(
    'the audience upload',
    async () => {
      const job = await api.get<{ status: string; error: string | null }>(`/api/imports/${upload.id}`);
      if (job.status === 'FAILED') throw new Error(`Audience upload failed: ${job.error ?? 'unknown error'}`);
      return job.status === 'COMPLETED' ? job : undefined;
    },
    5 * 60_000,
  );
  await api.patch(`/api/campaigns/${campaign.id}`, {
    variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'BODY.2': { source: 'static', value: '#PERF' } },
  });

  const started = Date.now();
  await api.post(`/api/campaigns/${campaign.id}/launch`);
  let lastLine = '';
  const done = await waitFor(
    'the campaign to complete',
    async () => {
      const c = await api.get<CampaignView>(`/api/campaigns/${campaign.id}`);
      const line = `${c.state} ${JSON.stringify(c.totals)}`;
      if (line !== lastLine) console.log(`  ${formatDuration(Date.now() - started)}  ${line}`);
      lastLine = line;
      if (c.state === 'PAUSED' || c.state === 'CANCELLED') throw new Error(`Campaign ${c.state.toLowerCase()}: ${c.pausedReasonText ?? ''}`);
      return c.state === 'COMPLETED' ? c : undefined;
    },
    LIMIT_MS + 5 * 60_000,
    5_000,
  );

  const durationMs = new Date(done.completedAt ?? Date.now()).getTime() - new Date(done.launchedAt ?? started).getTime();

  // SC-005: delivery statuses must keep up. mock-meta sends sent/delivered/read for every message.
  const settledAt = Date.now();
  const settled = await waitFor(
    'delivery statuses',
    async () => {
      const c = await api.get<CampaignView>(`/api/campaigns/${campaign.id}`);
      const final = (c.totals.delivered ?? 0) + (c.totals.read ?? 0) + (c.totals.failed ?? 0);
      return final >= RECIPIENTS * 0.99 ? c : undefined;
    },
    2 * 60_000,
    5_000,
  ).catch(() => undefined);
  const lastTotals = settled?.totals ?? (await api.get<CampaignView>(`/api/campaigns/${campaign.id}`)).totals;
  const sends = (await (await fetch(`${env.mockMetaUrl}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to: string }> };
  const mine = sends.messages.filter((m) => m.phoneNumberId === phoneNumberId);
  const unique = new Set(mine.map((m) => m.to)).size;

  report(`SC-002 campaign of ${RECIPIENTS} recipients`, [
    ['finished within 20 minutes', durationMs <= LIMIT_MS, formatDuration(durationMs)],
    ['every recipient sent once', mine.length === RECIPIENTS && unique === RECIPIENTS, `${mine.length} sends, ${unique} unique`],
    [
      'statuses arrived within 2 minutes of completion (SC-005)',
      settled !== undefined,
      `${settled ? formatDuration(Date.now() - settledAt) : 'timed out'}; totals ${JSON.stringify(lastTotals)}`,
    ],
    ['effective rate', true, `${(RECIPIENTS / (durationMs / 1000)).toFixed(1)} msg/s (configured ${SEND_RATE})`],
  ]);
});
