// Docker HEALTHCHECK for the api/worker image (T197). The same image runs either process, so the
// check reads PID 1's command line: the worker answers on WORKER_PORT /health, the API on
// API_PORT /api/health. Both endpoints require the X-Ops-Token header.
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = readFileSync('/proc/1/cmdline', 'utf8');
} catch {
  // Not on Linux (local run): assume the API.
}

const url = command.includes('worker.js')
  ? `http://127.0.0.1:${process.env.WORKER_PORT ?? 4001}/health`
  : `http://127.0.0.1:${process.env.API_PORT ?? 4000}/api/health`;

try {
  const res = await fetch(url, { headers: { 'x-ops-token': process.env.OPS_TOKEN ?? '' }, signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
