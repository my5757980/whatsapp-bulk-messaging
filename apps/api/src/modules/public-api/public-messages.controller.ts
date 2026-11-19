import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res, UseGuards, type PipeTransform } from '@nestjs/common';
import type { Response } from 'express';
import { z, type ZodType } from 'zod';
import { Public } from '../../common/auth/public.decorator.js';
import { AppError } from '../../common/errors/app-error.js';
import { ApiKeyGuard, type ApiKeyContext, type ApiRequest } from './api-key.guard.js';
import { PublicApiService, SendRequestSchema, type SendRequest } from './public-api.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

/** The public contract answers a malformed body with 400 (the dashboard API uses 422). */
class MalformedRequestPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw AppError.badRequest(
      'Malformed request',
      parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', issue: i.message })),
    );
  }
}

const isUuid = (id: string) => z.uuid().safeParse(id).success;

const keyOf = (req: ApiRequest): ApiKeyContext => {
  if (!req.apiKey) throw AppError.unauthorized('Missing or invalid API key');
  return req.apiKey;
};

/**
 * Public API v1 messages (contracts/public-api.openapi.yaml, T189). Authenticated by API key, not
 * by session or CSRF; every request counts against the key's per-minute limit.
 */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PublicMessagesController {
  constructor(private readonly api: PublicApiService) {}

  @Post('messages')
  @HttpCode(202)
  async send(
    @Body(new MalformedRequestPipe(SendRequestSchema)) body: SendRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey?.trim();
    if (key && key.length > 255) throw AppError.badRequest('Malformed request', [{ field: 'Idempotency-Key', issue: 'must be at most 255 characters' }]);
    const result = await this.api.send(body, keyOf(req), key || undefined);
    res.status(result.status);
    return result.body;
  }

  /** Only messages sent with the calling key are visible; anything else is "not found". */
  @Get('messages/:id')
  status(@Param('id') id: string, @Req() req: ApiRequest) {
    if (!isUuid(id)) throw AppError.notFound('Message not found');
    return this.api.status(id, keyOf(req));
  }
}
