import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T194: ops/alerts.yml covers the R19 alerts and only uses metrics the code exports.
// (Rule syntax is checked by `promtool check rules` in CI.)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALERTS = readFileSync(path.resolve(HERE, '../../../../ops/alerts.yml'), 'utf8');
const METRICS_SOURCE = readFileSync(path.resolve(HERE, '../../src/common/metrics/metrics.service.ts'), 'utf8');

/** The rule block of one alert: from its `- alert:` line to the next one. */
function rule(name: string): string {
  const start = ALERTS.indexOf(`- alert: ${name}\n`);
  expect(start, `alert ${name} is missing`).toBeGreaterThanOrEqual(0);
  const next = ALERTS.indexOf('- alert:', start + 1);
  return ALERTS.slice(start, next < 0 ? undefined : next);
}

describe('alert rules', () => {
  it('only reference metrics defined in MetricsService', () => {
    const defined = new Set([...METRICS_SOURCE.matchAll(/name: '(wbm_[a-z_]+)'/g)].map((m) => m[1]));
    const used = new Set([...ALERTS.matchAll(/\b(wbm_[a-z_]+)\b/g)].map((m) => m[1]!.replace(/_(bucket|count|sum)$/, '')));
    expect(used.size).toBeGreaterThan(0);
    for (const metric of used) expect(defined, `${metric} is not exported`).toContain(metric);
  });

  it('cover failure rate, stuck queues, webhook lag and missing webhooks', () => {
    expect(rule('WbmHighFailureRate')).toMatch(/\[10m\][\s\S]*> 0\.05/);
    expect(rule('WbmQueueNotDraining')).toMatch(/wbm_queue_depth[\s\S]*\[5m\]/);
    expect(rule('WbmSendQueueStalled')).toMatch(/wbm_queue_depth\{queue=~"send-\.\+"\}\[5m\]/);
    expect(rule('WbmWebhookLagHigh')).toMatch(/histogram_quantile\(0\.95[\s\S]*> 60/);
    expect(rule('WbmNoWebhooksWhileRunning')).toMatch(/wbm_campaigns_running\[15m\][\s\S]*wbm_webhook_lag_seconds_count\[15m\]/);
  });

  it('give every alert a severity and a summary', () => {
    const names = [...ALERTS.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const name of names) {
      expect(rule(name)).toMatch(/severity: (critical|warning)/);
      expect(rule(name)).toMatch(/summary: /);
    }
  });
});
