import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { StripeClient } from './stripe.client.js';

// Payments (feature 008, plan Structure Decision). Services other modules call live in a global
// domain module shared by the HTTP app and the worker (the Stripe client, payment requests and their
// effects, used by the inbound handler, the flow engine and store automations). HTTP controllers live
// in PaymentsApiModule, and the queue processors in WorkerFeaturesModule. Each story adds its
// providers here.
const DOMAIN: Provider[] = [StripeClient];

/** Payments services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class PaymentsDomainModule {}

const API_PROVIDERS: Provider[] = [];
const CONTROLLERS: Type[] = [];

/** The gateway, settings, payment requests, reports, the pay link and the Stripe webhook (HTTP app only). */
@Module({
  imports: [PaymentsDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class PaymentsApiModule {}
