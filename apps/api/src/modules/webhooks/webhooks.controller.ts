import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { Public } from '../../common/auth/public.decorator.js';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { QUEUES } from '../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../common/queue/queue.module.js';
import { verifyMetaSignature } from './signature.js';

export interface WebhookJobData {
  webhookEventId: string;
}

/**
 * Meta webhook endpoint (contracts/meta-webhooks.md, T061):
 * GET = verification handshake; POST = verify signature -> store raw event -> enqueue -> 200.
 * No business logic runs in the request (research R10).
 */
@Controller('webhooks/meta')
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @Public()
  verify(@Query() query: Record<string, unknown>, @Res() res: Response): void {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && typeof token === 'string' && token === this.config.META_WEBHOOK_VERIFY_TOKEN) {
      res.status(200).type('text/plain').send(typeof challenge === 'string' ? challenge : '');
      return;
    }
    res.status(403).json({ code: 'FORBIDDEN', message: 'Webhook verification failed' });
  }

  @Post()
  @Public()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const header = req.headers['x-hub-signature-256'];
    const signature = typeof header === 'string' ? header : undefined;
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, signature, this.config.META_APP_SECRET)) {
      await this.prisma.webhookEvent.create({ data: { signatureValid: false, payload: Prisma.DbNull } });
      throw AppError.unauthorized('Invalid webhook signature');
    }

    const event = await this.prisma.webhookEvent.create({
      data: { signatureValid: true, payload: req.body as Prisma.InputJsonValue },
    });
    await this.queues.get(QUEUES.WEBHOOKS).add(
      'meta-webhook',
      { webhookEventId: event.id } satisfies WebhookJobData,
      { jobId: `wh-${event.id}`, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
    );
    return { received: true };
  }
}
