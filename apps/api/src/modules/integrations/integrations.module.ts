import { Global, Module, type Provider, type Type } from '@nestjs/common';

// Integrations (feature 006, plan Structure Decision). The services that other modules call live in a
// global domain module shared by the HTTP app and the worker: the outbound event writer, the COD
// answer handler, the chat link matcher and the cart stop rules, which run inside the transactions of
// webhooks, live chat, consent and contact changes. HTTP controllers live in IntegrationsApiModule,
// and the queue processors in WorkerFeaturesModule. Each story adds its providers here.

const DOMAIN: Provider[] = [];

/** Integration services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class IntegrationsDomainModule {}

const API_PROVIDERS: Provider[] = [];
const CONTROLLERS: Type[] = [];

/** Webhook endpoint, API campaign, store, chat link and number wizard endpoints (HTTP app only). */
@Module({
  imports: [IntegrationsDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class IntegrationsApiModule {}
