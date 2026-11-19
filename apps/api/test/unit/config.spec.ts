import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/common/config/config.js';

// T029/T198: environment validation, including the production cookie rules.
const required = {
  DATABASE_URL: 'postgresql://wbm:wbm@localhost:5432/wbm',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OPS_TOKEN: 'o'.repeat(24),
  META_APP_SECRET: 'app-secret',
  META_WEBHOOK_VERIFY_TOKEN: 'verify-token',
};

describe('loadConfig', () => {
  it('accepts a development setup with plain-HTTP cookies', () => {
    const config = loadConfig({ ...required });
    expect(config.NODE_ENV).toBe('development');
    expect(config.COOKIE_SECURE).toBe(false);
  });

  it('lists every missing or invalid variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, OPS_TOKEN: 'short' })).toThrow(/OPS_TOKEN/);
  });

  it('requires secure cookies and an https APP_URL in production', () => {
    const production = { ...required, NODE_ENV: 'production' };
    expect(() => loadConfig({ ...production, APP_URL: 'https://wa.example.com' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...production, COOKIE_SECURE: 'true', APP_URL: 'http://wa.example.com' })).toThrow(/APP_URL/);
    expect(loadConfig({ ...production, COOKIE_SECURE: 'true', APP_URL: 'https://wa.example.com' }).COOKIE_SECURE).toBe(true);
  });
});
