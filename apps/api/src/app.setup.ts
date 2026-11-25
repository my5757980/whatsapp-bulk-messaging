import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';

/** HTTP pipeline shared by main.ts and the integration tests (T041). */
export function configureApp(app: INestApplication): INestApplication {
  // /metrics stays outside the /api prefix (scraped by Prometheus with X-Ops-Token), and so do
  // tracked links (/l/:code, feature 005), which phones open on the company's public address.
  app.setGlobalPrefix('api', { exclude: ['metrics', 'l/:code', 'l/c/:code', 'l/a/:code'] });
  // The web app proxies /api/*. Trusting X-Forwarded-For from loopback/private peers only gives
  // the login throttle and the audit log the real client IP (ADR-0005), not the proxy's.
  const express = app.getHttpAdapter().getInstance() as { set(setting: string, value: unknown): unknown };
  express.set('trust proxy', 'loopback, linklocal, uniquelocal');
  // The API only returns JSON and file downloads, so nothing it sends may run scripts or be
  // framed (T198); pages get their own CSP from the web app.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  return app;
}
