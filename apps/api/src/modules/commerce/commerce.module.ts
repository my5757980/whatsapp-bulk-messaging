import { Global, Module, type Provider, type Type } from '@nestjs/common';
import { InboxApiModule } from '../inbox/inbox.module.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogFill } from './catalog/catalog-fill.js';
import { CatalogService } from './catalog/catalog.service.js';
import { MetaCommerceClient } from './meta-commerce.client.js';
import { ProductMessagesController, ProductMessagesService } from './messages/product-messages.js';
import { ChatOrderService, ChatOrdersController } from './orders/chat-orders.js';
import { CHAT_ORDERS } from '../inbox/inbound/chat-orders.port.js';
import { FORM_ANSWERS } from '../inbox/inbound/form-answers.port.js';
import { TEMPLATE_FORM_TOKENS } from '../sending/template-form-tokens.port.js';
import { FormAnswersService } from './forms/form-answers.js';
import { FormTokens } from './forms/form-tokens.js';
import { FormsController, FormsService } from './forms/forms.js';
import { TemplateFormTokens } from './forms/template-form-tokens.js';
import { FLOW_COMMERCE } from '../flows/engine/ports.js';
import { FlowCommerce } from './flows/flow-commerce.js';

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
  FormTokens,
  FormAnswersService,
  // The ports for form answers (inbound) and form buttons of templates (sending).
  { provide: FORM_ANSWERS, useExisting: FormAnswersService },
  TemplateFormTokens,
  { provide: TEMPLATE_FORM_TOKENS, useExisting: TemplateFormTokens },
  FlowCommerce,
  // The port the flow engine uses for product, catalog and form steps.
  { provide: FLOW_COMMERCE, useExisting: FlowCommerce },
];

/** Commerce services shared by the HTTP app and the worker. */
@Global()
@Module({ providers: DOMAIN, exports: DOMAIN })
export class CommerceDomainModule {}

const API_PROVIDERS: Provider[] = [ProductMessagesService, FormsService];
const CONTROLLERS: Type[] = [CatalogController, ProductMessagesController, ChatOrdersController, FormsController];

/** The catalog, product messages, chat orders and forms endpoints (HTTP app only). */
@Module({
  imports: [CommerceDomainModule, InboxApiModule],
  providers: API_PROVIDERS,
  controllers: CONTROLLERS,
})
export class CommerceApiModule {}
