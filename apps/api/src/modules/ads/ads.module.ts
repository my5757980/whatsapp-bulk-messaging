import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { MetaAdsClient } from './meta-ads.client.js';

// Ads (feature 007, plan Structure Decision). Services other modules call live in a global domain
// module shared by the HTTP app and the worker: the Graph client and, from US3, the ad chat matcher
// that the 002 inbound handler calls. HTTP controllers live in AdsApiModule, and the queue processors
// in WorkerFeaturesModule. Each story adds its providers here.
const DOMAIN: Provider[] = [MetaAdsClient];

/** Ads services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class AdsDomainModule {}

const API_PROVIDERS: Provider[] = [];
const CONTROLLERS: Type[] = [];

/** The ads connection, campaigns, results, audiences and lead forms endpoints (HTTP app only). */
@Module({
  imports: [AdsDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class AdsApiModule {}
