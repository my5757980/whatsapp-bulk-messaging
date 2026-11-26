import { Controller, Headers, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../common/auth/public.decorator.js';
import { PaymentEventsService } from './payment-events.service.js';

/** Stripe notifications (feature 008, contracts/commerce-api.openapi.yaml POST /payments/stripe/webhook). */
@Controller('payments/stripe')
@Public()
export class StripeWebhookController {
  constructor(private readonly events: PaymentEventsService) {}

  @Post('webhook')
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    return this.events.receive(req.rawBody ?? Buffer.alloc(0), signature);
  }
}
