import { Global, Module, type Provider, type Type } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { LinkRateLimiter } from '../growth/links/link-rate-limiter.js';
import { AdAiTextController, AdAiTextService } from './campaigns/ad-ai-text.service.js';
import { AdLinkRedirectController, AdLinkRedirectService } from './links/ad-link-redirect.controller.js';
import { AdAudiencesController } from './audiences/ad-audiences.controller.js';
import { AdAudiencesService } from './audiences/ad-audiences.service.js';
import { AdCampaignsController } from './campaigns/ad-campaigns.controller.js';
import { AdCampaignsService } from './campaigns/ad-campaigns.service.js';
import { AdLauncher } from './campaigns/ad-launcher.js';
import { AdTargetingController } from './campaigns/ad-targeting.controller.js';
import { AdChatInfo, AdChatMatcher } from './chats/ad-chat-matcher.js';
import { AdChatsController } from './chats/ad-chats.controller.js';
import { AdsConnectionController } from './connection/ads-connection.controller.js';
import { AdsConnectionService } from './connection/ads-connection.service.js';
import { AdLeadFormsController } from './leads/ad-lead-forms.controller.js';
import { AdLeadFormsService } from './leads/ad-lead-forms.service.js';
import { MetaAdsClient } from './meta-ads.client.js';
import { AdResultsController } from './results/ad-results.controller.js';
import { AdResultsService } from './results/ad-results.service.js';
import { AdsCap } from './sync/ads-cap.js';

// Ads (feature 007, plan Structure Decision). Services other modules call live in a global domain
// module shared by the HTTP app and the worker: the Graph client and, from US3, the ad chat matcher
// that the 002 inbound handler calls. HTTP controllers live in AdsApiModule, and the queue processors
// in WorkerFeaturesModule. Each story adds its providers here.
const DOMAIN: Provider[] = [MetaAdsClient, AdsConnectionService, AdsCap, AdLauncher, AdCampaignsService, AdChatMatcher, AdChatInfo, AdAudiencesService, AdLeadFormsService];

/** Ads services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class AdsDomainModule {}

const API_PROVIDERS: Provider[] = [
  AdResultsService,
  AdAiTextService,
  AdLinkRedirectService,
  // Website ad links share the 005 per-client limit (the same Redis keys as tracked links).
  {
    provide: LinkRateLimiter,
    inject: [REDIS_CLIENT, APP_CONFIG],
    useFactory: (redis: Redis, config: AppConfig) => new LinkRateLimiter(redis, config.TOKEN_ENCRYPTION_KEY),
  },
];
const CONTROLLERS: Type[] = [AdsConnectionController, AdCampaignsController, AdTargetingController, AdChatsController, AdResultsController, AdAudiencesController, AdLeadFormsController, AdAiTextController, AdLinkRedirectController];

/** The ads connection, campaigns, results, audiences and lead forms endpoints (HTTP app only). */
@Module({
  imports: [AdsDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class AdsApiModule {}
