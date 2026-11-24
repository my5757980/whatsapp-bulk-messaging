import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { redactRequestPath, sanitizeLogObject } from './redaction.js';

/**
 * Structured JSON logs (constitution Principle VI, research R19):
 * - correlation id from `x-request-id` (or a new uuid), echoed back on the response
 * - secrets and message text redacted, phone numbers masked (T034)
 * - request/response serialised without headers or bodies
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          genReqId: (req: IncomingMessage, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          customProps: (req: IncomingMessage) => {
            const user = (req as IncomingMessage & { user?: { id: string } }).user;
            return user ? { userId: user.id } : {};
          },
          serializers: {
            // Path only: query strings can carry secrets (e.g. the webhook hub.verify_token), and
            // tracked-link codes in `/l/{code}` are hidden (feature 005, FR-041).
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: redactRequestPath(req.url),
            }),
            res: (res: { statusCode?: number | null; raw?: { statusCode?: number } }) => ({
              statusCode: res.raw?.statusCode ?? res.statusCode ?? null,
            }),
          },
          formatters: {
            log: (object: Record<string, unknown>) => sanitizeLogObject(object) as Record<string, unknown>,
          },
          transport:
            config.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
