import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { ClickRecorder } from './links/click-recorder.js';
import { ClicksController } from './links/clicks.controller.js';
import { ClicksService } from './links/clicks.service.js';
import { TrackedLinkCodes } from './links/link-codes.js';
import { LinkRateLimiter } from './links/link-rate-limiter.js';
import { LinkRedirectController } from './links/link-redirect.controller.js';
import { LinkRedirectService } from './links/link-redirect.service.js';
import { LinkResolver } from './links/link-resolver.js';
import { TrackedLinksController } from './links/tracked-links.controller.js';
import { TrackedLinksService } from './links/tracked-links.service.js';
import { DripEvents } from './drips/drip-events.js';
import { DripLeaving } from './drips/drip-leaving.js';
import { DripsController } from './drips/drips.controller.js';
import { DripsService } from './drips/drips.service.js';
import { EnrolmentsService } from './drips/enrolments.service.js';
import { RetriesController } from './retries/retries.controller.js';
import { RetryPlanService } from './retries/retry-plan.service.js';
import { RetryRoundsService } from './retries/retry-rounds.service.js';

// Campaign growth wiring (feature 005, T013), following 002-004: services shared by the HTTP app and
// the worker in a global domain module (campaign launch needs the tracked links in both; later the
// drip event writer and the leaving rules are called from contacts, consent, imports, flows, the
// public API and live chat code), HTTP controllers in GrowthApiModule, and the `drips` tick and the
// retry-round processor in WorkerFeaturesModule. Each story adds its providers here.

// Retry rounds are finished and scheduled by the campaign progress worker and cancelled with their
// campaign, so they are shared too, and so are the drip leaving rules, which run inside the
// transactions of replies, opt-outs, blocks, deletions and status webhooks.
const DOMAIN = [TrackedLinksService, TrackedLinkCodes, RetryRoundsService, DripLeaving, DripEvents];

/** Campaign growth services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class GrowthDomainModule {}

/** Tracked links, clicks, retry plans and drips endpoints (HTTP app only). */
@Module({
  imports: [GrowthDomainModule],
  providers: [
    LinkResolver,
    ClickRecorder,
    LinkRedirectService,
    ClicksService,
    RetryPlanService,
    DripsService,
    EnrolmentsService,
    {
      provide: LinkRateLimiter,
      inject: [REDIS_CLIENT, APP_CONFIG],
      useFactory: (redis: Redis, config: AppConfig) => new LinkRateLimiter(redis, config.TOKEN_ENCRYPTION_KEY),
    },
  ],
  controllers: [LinkRedirectController, TrackedLinksController, ClicksController, RetriesController, DripsController],
})
export class GrowthApiModule {}
