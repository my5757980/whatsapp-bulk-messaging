import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, Headers, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../../../common/auth/public.decorator.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StoreEventsInbox } from './store-events-inbox.js';
import { StoreHttp, type ShopifyCredentials } from './store-http.js';

// The store webhook receivers (feature 006 US4, contracts/integrations-api.openapi.yaml, research R7 -
// R9). The signature is checked on the raw body before anything else; the event is then saved once
// and queued, and the store gets its 200 at once.

const isUuid = (v: string) => z.uuid().safeParse(v).success;

/** Constant-time compare of two base64 HMACs. */
function sameSignature(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller('integrations')
@Public()
export class StoreWebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly http: StoreHttp,
    private readonly inbox: StoreEventsInbox,
  ) {}

  private async store(storeId: string, platform: 'SHOPIFY' | 'WOOCOMMERCE') {
    const store = isUuid(storeId) ? await this.prisma.storeConnection.findUnique({ where: { id: storeId } }) : null;
    if (!store || store.platform !== platform || store.status === 'DISCONNECTED') throw AppError.notFound('Unknown or disconnected store');
    return store;
  }

  @Post('shopify/:storeId/webhooks')
  @HttpCode(200)
  async shopify(
    @Param('storeId') storeId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-shopify-hmac-sha256') signature: string | undefined,
    @Headers('x-shopify-webhook-id') webhookId: string | undefined,
    @Headers('x-shopify-topic') topic: string | undefined,
  ) {
    const store = await this.store(storeId, 'SHOPIFY');
    const { clientSecret } = this.http.open<ShopifyCredentials>(store.credentialsEncrypted);
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (!sameSignature(signature, createHmac('sha256', clientSecret).update(raw).digest('base64'))) throw AppError.unauthorized('Signature missing or wrong');
    if (!webhookId || !topic) return { received: false };
    const saved = await this.inbox.save(store.id, webhookId, topic, JSON.parse(raw.toString('utf8') || '{}'));
    return { received: true, duplicate: saved === null };
  }

  @Post('woocommerce/:storeId/webhooks')
  @HttpCode(200)
  async woocommerce(
    @Param('storeId') storeId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-wc-webhook-signature') signature: string | undefined,
    @Headers('x-wc-webhook-delivery-id') deliveryId: string | undefined,
    @Headers('x-wc-webhook-topic') topic: string | undefined,
  ) {
    const store = await this.store(storeId, 'WOOCOMMERCE');
    const raw = req.rawBody ?? Buffer.alloc(0);
    // WooCommerce pings a new webhook with an unsigned "webhook_id=…" form body: answered, then ignored.
    if (!signature && /^webhook_id=\d+$/.test(raw.toString('utf8').trim())) return { received: false, ping: true };
    const secret = store.webhookSecretEncrypted ? this.http.open<{ secret: string }>(store.webhookSecretEncrypted).secret : '';
    if (!secret || !sameSignature(signature, createHmac('sha256', secret).update(raw).digest('base64'))) throw AppError.unauthorized('Signature missing or wrong');
    if (!deliveryId || !topic) return { received: false };
    const saved = await this.inbox.save(store.id, deliveryId, topic, JSON.parse(raw.toString('utf8') || '{}'));
    return { received: true, duplicate: saved === null };
  }
}
