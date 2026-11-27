// Lists every failed test of a Vitest JSON report in the job log and as a few GitHub annotations
// (a step shows at most 10 error annotations, so failures are grouped 15 to an annotation).
// Usage: node tools/ci/vitest-failures.mjs <report.json> <label>
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [file, label = 'tests'] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.log(`No ${label} report at ${file ?? '(none given)'}`);
  process.exit(0);
}
const report = JSON.parse(readFileSync(file, 'utf8'));
/** Terminal colour codes (ESC [ ... m) in failure messages. */
const ESC = String.fromCharCode(27);
const stripColours = (text) => text.split(ESC).map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, ''))).join('');
const brief = (text) =>
  stripColours(String(text ?? ''))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' | ')
    .slice(0, 400);

const lines = [];
for (const suite of report.testResults ?? []) {
  const where = relative(process.cwd(), suite.name ?? '').replace(/\\/g, '/');
  const failed = (suite.assertionResults ?? []).filter((t) => t.status === 'failed');
  if (!failed.length && suite.status === 'failed') lines.push(`${where}: ${brief(suite.message)}`);
  for (const t of failed) lines.push(`${where} > ${t.fullName ?? t.title}: ${brief(t.failureMessages?.[0])}`);
}
console.log(`${lines.length} failed ${label} test(s)`);
console.log(lines.join('\n'));
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (let i = 0; i < lines.length; i += 15) {
  const part = lines.slice(i, i + 15);
  console.log(`::error title=Failed ${label} tests ${i + 1}-${i + part.length} of ${lines.length}::${escape(part.join('\n'))}`);
}
