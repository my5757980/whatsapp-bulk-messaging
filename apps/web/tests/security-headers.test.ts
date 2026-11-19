import { describe, expect, it } from 'vitest';
import nextConfig, { securityHeaders } from '../next.config';

// T198: Content-Security-Policy and related headers for the web app.
describe('security headers', () => {
  const byKey = (isDev: boolean) => Object.fromEntries(securityHeaders(isDev).map((h) => [h.key, h.value]));

  it('limit production pages to this origin and forbid framing', () => {
    const headers = byKey(false);
    const csp = headers['Content-Security-Policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(headers['Strict-Transport-Security']).toMatch(/^max-age=\d+/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('allow dev tooling only in development', () => {
    const headers = byKey(true);
    expect(headers['Content-Security-Policy']).toContain("'unsafe-eval'");
    expect(headers['Content-Security-Policy']).toContain('ws:');
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('apply to pages but not to API responses proxied from the backend', async () => {
    const [rule] = await nextConfig.headers!();
    const matches = (path: string) => new RegExp(`^${rule!.source}$`).test(path);
    expect(matches('/')).toBe(true);
    expect(matches('/campaigns/new')).toBe(true);
    expect(matches('/api/campaigns')).toBe(false);
  });
});
