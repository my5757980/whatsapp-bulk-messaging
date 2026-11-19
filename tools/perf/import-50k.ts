// SC-007 performance check (T196): a 50,000-row contacts import finishes within 5 minutes.
//
// Needs the api and the worker running (web and mock-meta are not needed), plus a seeded admin:
//   npm run perf:import
// Env: PERF_API_URL, PERF_ADMIN_EMAIL, PERF_ADMIN_PASSWORD, PERF_ROWS (default 50000),
//      PERF_PHONE_PREFIX (default +97154; use another UAE mobile prefix such as +97156 to import
//      new contacts instead of updating the ones from an earlier run).
import { ApiClient, csvPart, formatDuration, perfEnv, report, run, waitFor } from './client.js';

const ROWS = Number(process.env.PERF_ROWS ?? 50_000);
const PHONE_PREFIX = process.env.PERF_PHONE_PREFIX ?? '+97154';
const LIMIT_MS = 5 * 60_000;

interface ImportJobView {
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

run(async () => {
  const api = await ApiClient.signIn(perfEnv());
  const suffix = Date.now().toString().slice(-6);
  console.log(`Import of ${ROWS} contacts (limit ${formatDuration(LIMIT_MS)})`);

  const rows = ['phone,name,tags', ...Array.from({ length: ROWS }, (_, i) => `${PHONE_PREFIX}${String(i).padStart(7, '0')},Perf contact ${i + 1},perf-${suffix}`)];
  const form = new FormData();
  form.set('file', csvPart(rows), 'perf-contacts.csv');
  form.set('mapping', JSON.stringify({ phone: 'phone', name: 'name', tags: 'tags' }));

  const started = Date.now();
  const job = await api.upload<{ id: string }>('/api/imports', form);
  let lastLine = '';
  const done = await waitFor(
    'the import to finish',
    async () => {
      const j = await api.get<ImportJobView>(`/api/imports/${job.id}`);
      const line = `${j.status} rows=${j.totalRows} created=${j.createdCount} updated=${j.updatedCount} errors=${j.errorCount}`;
      if (line !== lastLine) console.log(`  ${formatDuration(Date.now() - started)}  ${line}`);
      lastLine = line;
      if (j.status === 'FAILED') throw new Error(`Import failed: ${j.error ?? 'unknown error'}`);
      return j.status === 'COMPLETED' ? j : undefined;
    },
    LIMIT_MS + 5 * 60_000,
  );

  const totalMs = Date.now() - started;
  const imported = done.createdCount + done.updatedCount;
  report(`SC-007 import of ${ROWS} rows`, [
    ['finished within 5 minutes (upload included)', totalMs <= LIMIT_MS, formatDuration(totalMs)],
    ['every row imported', imported === ROWS && done.errorCount === 0, `${imported} imported, ${done.skippedCount} skipped, ${done.errorCount} errors`],
  ]);
});
