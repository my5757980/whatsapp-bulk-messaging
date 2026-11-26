import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { MetaCommerceClient } from './meta-commerce.client.js';

// Commerce (feature 008, plan Structure Decision): the Meta catalog and product messages, chat orders
// and WhatsApp Forms. The global domain module holds what the worker's inbound handler and the flow
// engine call (product sends, chat orders, form answers); controllers live in CommerceApiModule and
// the queue processors in WorkerFeaturesModule. Each story adds its providers here.
const DOMAIN: Provider[] = [MetaCommerceClient];

/** Commerce services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class CommerceDomainModule {}

const API_PROVIDERS: Provider[] = [];
const CONTROLLERS: Type[] = [];

/** The catalog, product messages, chat orders and forms endpoints (HTTP app only). */
@Module({
  imports: [CommerceDomainModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class CommerceApiModule {}
