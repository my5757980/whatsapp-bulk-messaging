import { Global, Module, type Provider, type Type } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { LinkRateLimiter } from '../growth/links/link-rate-limiter.js';
import { InboxApiModule } from '../inbox/inbox.module.js';
import { PaymentEventsService } from './events/payment-events.service.js';
import { StripeWebhookController } from './events/stripe-webhook.controller.js';
import { PaymentGatewayController } from './gateway/payment-gateway.controller.js';
import { PaymentGatewayService } from './gateway/payment-gateway.service.js';
import { PayLinkController, PayLinkService } from './links/pay-link.controller.js';
import { PaymentChatService } from './requests/payment-chat.service.js';
import { PaymentEffects } from './requests/payment-effects.js';
import { PaymentRequestsController } from './requests/payment-requests.controller.js';
import { PaymentRequestsService } from './requests/payment-requests.service.js';
import { PaymentSender } from './requests/payment-sender.js';
import { PaymentSessions } from './requests/payment-sessions.js';
import { PaymentSettingsController } from './settings/payment-settings.controller.js';
import { PaymentSettingsService } from './settings/payment-settings.service.js';
import { StripeClient } from './stripe.client.js';

// Payments (feature 008, plan Structure Decision). Services other modules call live in a global
// domain module shared by the HTTP app and the worker: the Stripe client, the connection, settings,
// stored events, payment requests with their sessions, sending and effects (used by the inbound
// handler, the flow engine, campaigns, store automations and the payments queue). Chat actions,
// controllers and the pay link live in PaymentsApiModule (they need the 002 reply path), and the
// queue processors in WorkerFeaturesModule. Each story adds its providers here.
const DOMAIN: Provider[] = [
  StripeClient,
  PaymentGatewayService,
  PaymentSettingsService,
  PaymentEventsService,
  PaymentEffects,
  PaymentSessions,
  PaymentSender,
  PaymentRequestsService,
];

/** Payments services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class PaymentsDomainModule {}

const API_PROVIDERS: Provider[] = [
  PaymentChatService,
  PayLinkService,
  // Pay links share the 005 per-client limit (the same Redis keys as tracked links).
  {
    provide: LinkRateLimiter,
    inject: [REDIS_CLIENT, APP_CONFIG],
    useFactory: (redis: Redis, config: AppConfig) => new LinkRateLimiter(redis, config.TOKEN_ENCRYPTION_KEY),
  },
];
const CONTROLLERS: Type[] = [PaymentGatewayController, PaymentSettingsController, StripeWebhookController, PaymentRequestsController, PayLinkController];

/** The gateway, settings, payment requests, reports, the pay link and the Stripe webhook (HTTP app only). */
@Module({
  imports: [PaymentsDomainModule, InboxApiModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class PaymentsApiModule {}
