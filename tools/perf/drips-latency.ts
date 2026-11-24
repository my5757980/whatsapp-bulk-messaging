// SC-005 check for drips (005 T065): with 10,000 contacts in an active drip, 95% of drip steps are
// queued for sending within 5 minutes of falling due. Quiet hours and the number's sending limits
// are left out: the drip has no quiet hours, and the time is measured until each step's message is
// handed to the number's send queue (the enrolment of a one-step drip finishes at that moment).
//
// The run imports the contacts with their own tag, builds a one-step drip with no wait, enrols them
// all by the tag at once (every step falls due at the same moment, the worst case), waits until each
// contact finished, reads the times from the drip's contact list, then archives the drip.
//
// Needs the api and the worker running (mock-meta for the template), plus a seeded admin:
//   PERF_NUMBER_ID=<id> npm run perf:drips
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, PERF_NUMBER_ID (a connected number with
//      the approved template), PERF_TEMPLATE (default order_confirmation), PERF_CONTACTS (default
//      10000), PERF_PHONE_PREFIX (default +97155).
import { ApiClient, csvPart, formatDuration, p95, perfEnv, report, run, waitFor } from './client.js';

const CONTACTS = Number(process.env.PERF_CONTACTS ?? 10_000);
const TEMPLATE = process.env.PERF_TEMPLATE ?? 'order_confirmation';
const PHONE_PREFIX = process.env.PERF_PHONE_PREFIX ?? '+97155';
const LIMIT_MS = 5 * 60_000;
const PAGE_SIZE = 200;

interface Enrolment {
  status: string;
  joinedAt: string;
  endedAt: string | null;
}

interface Results {
  active: number;
  finished: number;
  left: Record<string, number>;
  steps: Array<{ sent: number; failed: number; skipped: number }>;
}

run(async () => {
  const env = perfEnv();
  const numberId = process.env.PERF_NUMBER_ID;
  if (!numberId) throw new Error('Set PERF_NUMBER_ID to a connected number (for example one from npm run perf:inbox-seed)');
  const api = await ApiClient.signIn(env);
  const number = await api.get<Array<{ id: string; wabaId: string }>>('/api/numbers').then((all) => all.find((n) => n.id === numberId));
  if (!number) throw new Error(`Number ${numberId} not found`);
  const template = (await api.get<Array<{ id: string; name: string }>>(`/api/templates?wabaId=${number.wabaId}&status=APPROVED`)).find((t) => t.name === TEMPLATE);
  if (!template) throw new Error(`Approved template ${TEMPLATE} not found for this number - sync templates first`);

  const suffix = Date.now().toString().slice(-6);
  const tag = `perf-drip-${suffix}`;
  console.log(`Drip of ${CONTACTS} contacts, every step due at once (limit p95 ${formatDuration(LIMIT_MS)})`);

  // 1. The contacts, opted in, with their own tag.
  const rows = [
    'phone,name,tags,source',
    ...Array.from({ length: CONTACTS }, (_, i) => `${PHONE_PREFIX}${String(i).padStart(7, '0')},Drip contact ${i + 1},${tag},Performance test list`),
  ];
  const form = new FormData();
  form.set('file', csvPart(rows), 'perf-drip-contacts.csv');
  form.set('mapping', JSON.stringify({ phone: 'phone', name: 'name', tags: 'tags', optInSource: 'source' }));
  const job = await api.upload<{ id: string }>('/api/imports', form);
  await waitFor(
    'the contacts import',
    async () => {
      const j = await api.get<{ status: string; error: string | null }>(`/api/imports/${job.id}`);
      if (j.status === 'FAILED') throw new Error(`Import failed: ${j.error ?? 'unknown error'}`);
      return j.status === 'COMPLETED' ? j : undefined;
    },
    10 * 60_000,
  );

  // 2. A one-step drip with no wait and no quiet hours.
  const drip = await api.post<{ id: string }>('/api/drips', { name: `Perf drip ${suffix}`, numberId });
  await api.request('PUT', `/api/drips/${drip.id}/steps`, {
    json: { steps: [{ templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'static', value: '#PERF' } }, waitMinutes: 0 }] },
  });
  await api.post(`/api/drips/${drip.id}/activate`);

  try {
    // 3. Everyone joins at once: each step falls due when its contact joins.
    const enrolStarted = Date.now();
    const enrolled = await api.post<{ enrolled: number }>(`/api/drips/${drip.id}/enrolments`, { filter: { all: [{ tag }] } });
    console.log(`  enrolled ${enrolled.enrolled} contacts in ${formatDuration(Date.now() - enrolStarted)}`);

    // 4. Wait until every contact finished the step.
    const started = Date.now();
    let lastLine = '';
    const done = await waitFor(
      'every drip step to be queued',
      async () => {
        const r = await api.get<Results>(`/api/drips/${drip.id}/results`);
        const line = `in=${r.active} finished=${r.finished} sent=${r.steps[0]?.sent ?? 0} skipped=${r.steps[0]?.skipped ?? 0}`;
        if (line !== lastLine) console.log(`  ${formatDuration(Date.now() - started)}  ${line}`);
        lastLine = line;
        return r.active === 0 ? r : undefined;
      },
      LIMIT_MS + 10 * 60_000,
      5_000,
    );

    // 5. From falling due (joining) to queued (finishing), for each contact.
    const lags: number[] = [];
    for (let page = 1; ; page += 1) {
      const list = await api.get<{ items: Enrolment[]; total: number }>(`/api/drips/${drip.id}/enrolments?status=FINISHED&page=${page}&pageSize=${PAGE_SIZE}`);
      for (const e of list.items) if (e.endedAt) lags.push(new Date(e.endedAt).getTime() - new Date(e.joinedAt).getTime());
      if (list.items.length < PAGE_SIZE) break;
    }
    const step = done.steps[0] ?? { sent: 0, failed: 0, skipped: 0 };
    const lagP95 = p95(lags);
    report(`SC-005 drip of ${CONTACTS} contacts`, [
      ['every contact joined', enrolled.enrolled === CONTACTS, `${enrolled.enrolled} of ${CONTACTS}`],
      ['every step queued, none skipped', done.finished === CONTACTS && step.skipped === 0, `${done.finished} finished, ${step.skipped} skipped, left ${JSON.stringify(done.left)}`],
      ['95% of steps queued within 5 minutes of falling due', lags.length === CONTACTS && lagP95 <= LIMIT_MS, `p95 ${formatDuration(lagP95)}, slowest ${formatDuration(Math.max(0, ...lags))}`],
      ['sending so far', true, `${step.sent} sent, ${step.failed} failed (the number's send rate applies after queueing)`],
    ]);
  } finally {
    await api.post(`/api/drips/${drip.id}/archive`).catch(() => undefined);
  }
});
