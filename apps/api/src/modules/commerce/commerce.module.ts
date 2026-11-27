import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { InboxApiModule } from '../inbox/inbox.module.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogFill } from './catalog/catalog-fill.js';
import { CatalogService } from './catalog/catalog.service.js';
import { MetaCommerceClient } from './meta-commerce.client.js';
import { ProductMessagesController, ProductMessagesService } from './messages/product-messages.js';
import { ChatOrderService, ChatOrdersController } from './orders/chat-orders.js';
import { CHAT_ORDERS } from '../inbox/inbound/chat-orders.port.js';

// Commerce (feature 008, plan Structure Decision): the Meta catalog and product messages, chat orders
// and WhatsApp Forms. The global domain module holds what the worker's inbound handler and the flow
// engine call (product sends, chat orders, form answers); controllers live in CommerceApiModule and
// the queue processors in WorkerFeaturesModule. Each story adds its providers here.

const DOMAIN: Provider[] = [
  MetaCommerceClient,
  CatalogService,
  CatalogFill,
  ChatOrderService,
  // The port the inbound handler calls for carts (the inbox never imports commerce).
  { provide: CHAT_ORDERS, useExisting: ChatOrderService },
];

/** Commerce services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class CommerceDomainModule {}

const API_PROVIDERS: Provider[] = [ProductMessagesService];
const CONTROLLERS: Type[] = [CatalogController, ProductMessagesController, ChatOrdersController];

/** The catalog, product messages, chat orders and forms endpoints (HTTP app only). */
@Module({
  imports: [CommerceDomainModule, InboxApiModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class CommerceApiModule {}
