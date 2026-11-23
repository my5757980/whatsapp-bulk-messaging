import { Global, Module } from '@nestjs/common';

// Campaign growth wiring (feature 005, T013), following 002-004: services shared by the HTTP app and
// the worker in a global domain module (the drip event writer, the leaving rules and the click
// recorder are called from contacts, consent, imports, flows, the public API and live chat code),
// HTTP controllers in GrowthApiModule, and the `drips` tick and the retry-round processor in
// WorkerFeaturesModule. Each story adds its providers here.

const DOMAIN: Array<new (...args: never[]) => unknown> = [];

/** Campaign growth services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class GrowthDomainModule {}

/** Tracked links, clicks, retry plans and drips endpoints (HTTP app only). */
@Module({
  imports: [GrowthDomainModule],
  providers: [],
  controllers: [],
})
export class GrowthApiModule {}
