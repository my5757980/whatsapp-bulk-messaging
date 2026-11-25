import { Global, Module, type Provider, type Type } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { LinkRateLimiter } from '../growth/links/link-rate-limiter.js';
import { ApiCampaignPauser } from './api-campaigns/api-campaign-pauser.js';
import { ApiCampaignsController } from './api-campaigns/api-campaigns.controller.js';
import { ApiCampaignsService } from './api-campaigns/api-campaigns.service.js';
import { ChatLinkMatcher } from './chat-links/chat-link-matcher.js';
import { ChatLinkRedirectController } from './chat-links/chat-link-redirect.controller.js';
import { ChatLinkRedirectService } from './chat-links/chat-link-redirect.service.js';
import { ChatLinksController } from './chat-links/chat-links.controller.js';
import { ChatLinksService } from './chat-links/chat-links.service.js';
import { NumberWizardController } from './number-wizard/number-wizard.controller.js';
import { NumberWizardService } from './number-wizard/number-wizard.service.js';
import { CodService } from './stores/cod.service.js';
import { StoreCarts } from './stores/store-carts.js';
import { ShopifyClient } from './stores/shopify/shopify.client.js';
import { StoreAutomationsService } from './stores/store-automations.service.js';
import { StoreConnectionsService } from './stores/store-connections.service.js';
import { StoreEventsInbox } from './stores/store-events-inbox.js';
import { StoreHttp } from './stores/store-http.js';
import { StoreMessages } from './stores/store-messages.js';
import { StoreWebhooksController } from './stores/store-webhooks.controller.js';
import { StoresController } from './stores/stores.controller.js';
import { WooClient } from './stores/woocommerce/woo.client.js';
import { OutboundEvents } from './webhooks/outbound-events.js';
import { PlatformEvents } from './webhooks/platform-events.js';
import { WebhookBacklogCollector } from './webhooks/webhook-backlog.collector.js';
import { WebhookDeliveries } from './webhooks/webhook-deliveries.service.js';
import { WebhookEndpointsController } from './webhooks/webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './webhooks/webhook-endpoints.service.js';

// Integrations (feature 006, plan Structure Decision). The services that other modules call live in a
// global domain module shared by the HTTP app and the worker: the outbound event writer, the COD
// answer handler, the chat link matcher and the cart stop rules, which run inside the transactions of
// webhooks, live chat, consent and contact changes. HTTP controllers live in IntegrationsApiModule,
// and the queue processors in WorkerFeaturesModule. Each story adds its providers here.

// The API campaign pauser runs from template webhooks and number disconnects (US3, FR-021).
// Store clients, the raw event store and store messages are used by receivers, processors and the COD and cart ticks (US4 - US6).
// The chat link matcher runs from the 002 inbound handler in the worker (US7).
const DOMAIN: Provider[] = [OutboundEvents, WebhookDeliveries, PlatformEvents, ApiCampaignPauser, StoreHttp, ShopifyClient, WooClient, StoreEventsInbox, StoreMessages, CodService, StoreCarts, ChatLinkMatcher, WebhookBacklogCollector];

/** Integration services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class IntegrationsDomainModule {}

const API_PROVIDERS: Provider[] = [
  WebhookEndpointsService,
  ApiCampaignsService,
  StoreConnectionsService,
  StoreAutomationsService,
  ChatLinksService,
  ChatLinkRedirectService,
  NumberWizardService,
  // Chat link openings share the 005 per-client limit (the same Redis keys as tracked links).
  {
    provide: LinkRateLimiter,
    inject: [REDIS_CLIENT, APP_CONFIG],
    useFactory: (redis: Redis, config: AppConfig) => new LinkRateLimiter(redis, config.TOKEN_ENCRYPTION_KEY),
  },
];
const CONTROLLERS: Type[] = [WebhookEndpointsController, ApiCampaignsController, StoresController, StoreWebhooksController, ChatLinksController, ChatLinkRedirectController, NumberWizardController];

/** Webhook endpoint, API campaign, store, chat link and number wizard endpoints (HTTP app only). */
@Module({
  imports: [IntegrationsDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class IntegrationsApiModule {}
