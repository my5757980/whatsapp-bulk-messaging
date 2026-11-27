import { Body, Controller, HttpStatus, Injectable, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { COMMERCE_LIMITS, notSendableReason, permissionsFor, productListProblem } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { isLive } from '../../inbox/conversations/window.js';
import { SessionSendService } from '../../inbox/messages/session-send.service.js';
import { CatalogService, productDto } from '../catalog/catalog.service.js';

// Product messages in the 24-hour window (feature 008 US5, FR-023, research R10): one product, a
// product list (1–10 sections, at most 30 products) or the whole catalog, sent through the 002
// session path as interactive messages (chat items PRODUCT, PRODUCT_LIST, CATALOG). Only products
// that may be sent are accepted; the error names the others.

const text = (max: number) => z.string().trim().max(max);
export const ProductMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('product'), retailerId: z.string().trim().min(1).max(100), body: text(COMMERCE_LIMITS.body).optional(), footer: text(COMMERCE_LIMITS.footer).optional() }).strict(),
  z
    .object({
      kind: z.literal('list'),
      header: text(COMMERCE_LIMITS.header).min(1),
      body: text(COMMERCE_LIMITS.body).min(1),
      footer: text(COMMERCE_LIMITS.footer).optional(),
      sections: z.array(z.object({ title: text(COMMERCE_LIMITS.sectionTitle).optional(), retailerIds: z.array(z.string().trim().min(1).max(100)).min(1).max(COMMERCE_LIMITS.listItems) }).strict()).min(1).max(COMMERCE_LIMITS.listSections),
    })
    .strict(),
  z.object({ kind: z.literal('catalog'), body: text(COMMERCE_LIMITS.body).min(1), footer: text(COMMERCE_LIMITS.footer).optional(), thumbnailRetailerId: z.string().trim().min(1).max(100).optional() }).strict(),
]);
export type ProductMessageInput = z.infer<typeof ProductMessageSchema>;

const viewerOf = (user: RequestUser) => ({ id: user.id, role: user.role, permissions: new Set<string>(permissionsFor(user.role)) });

@Injectable()
export class ProductMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly sessions: SessionSendService,
  ) {}

  async send(user: RequestUser, conversationId: string, input: ProductMessageInput): Promise<{ chatItemId: string }> {
    const viewer = viewerOf(user);
    const chat = await this.sessions.prepare(viewer, conversationId, { requireWindow: false });
    if (!isLive(chat.lastCustomerMessageAt)) throw AppError.conflict('The 24-hour reply window has closed. Use a catalog template instead.', 'WINDOW_CLOSED');
    const connection = await this.catalog.requireConnection();
    const number = await this.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: chat.number.id }, select: { wabaId: true } });
    if (!(await this.catalog.ensureNumberHasCatalog(connection, number.wabaId))) throw AppError.conflict("This number's WhatsApp account has no catalog connected in Commerce Manager", 'NUMBER_NO_CATALOG');

    const ids = input.kind === 'product' ? [input.retailerId] : input.kind === 'list' ? input.sections.flatMap((s) => s.retailerIds) : input.thumbnailRetailerId ? [input.thumbnailRetailerId] : [];
    if (input.kind === 'list') {
      const problem = productListProblem(input.sections);
      if (problem) throw AppError.validation(problem, [{ field: 'sections', issue: problem }]);
    }
    const products = ids.length ? await this.prisma.catalogProduct.findMany({ where: { retailerId: { in: ids } } }) : [];
    const byId = new Map(products.map((p) => [p.retailerId, p]));
    const refused = ids.flatMap((id) => {
      const product = byId.get(id);
      const reason = product ? notSendableReason(product) : 'REMOVED';
      return reason ? [{ field: id, issue: reason }] : [];
    });
    if (refused.length) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'PRODUCT_NOT_SENDABLE', `These products cannot be sent: ${refused.map((r) => r.field).join(', ')}`, refused);

    const summary = (id: string) => {
      const p = productDto(byId.get(id)!);
      return { retailerId: p.retailerId, name: p.name, priceMinor: p.salePriceMinor ?? p.priceMinor, currency: p.currency, imageUrl: p.imageUrl };
    };
    const base = { catalogId: connection.catalogId, ...(input.footer ? { footer: input.footer } : {}) };
    const outgoing =
      input.kind === 'product'
        ? { contentType: 'PRODUCT' as const, text: input.body ?? null, mediaAssetId: null, payload: { ...base, retailerId: input.retailerId, products: [summary(input.retailerId)] } }
        : input.kind === 'list'
          ? {
              contentType: 'PRODUCT_LIST' as const,
              text: input.body,
              mediaAssetId: null,
              payload: { ...base, header: input.header, sections: input.sections.map((s) => ({ title: s.title ?? null, retailerIds: s.retailerIds })), products: ids.map(summary) },
            }
          : { contentType: 'CATALOG' as const, text: input.body, mediaAssetId: null, payload: { ...base, thumbnailRetailerId: input.thumbnailRetailerId ?? null, products: ids.map(summary) } };
    const item = await this.sessions.sendPrepared(viewer, chat, outgoing);
    return { chatItemId: item.id };
  }
}

/** POST /inbox/conversations/{id}/products (contracts/commerce-api.openapi.yaml). */
@Controller('inbox/conversations')
export class ProductMessagesController {
  constructor(private readonly messages: ProductMessagesService) {}

  @Post(':id/products')
  @Require('inbox.reply')
  send(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ProductMessageSchema)) body: ProductMessageInput, @CurrentUser() user: RequestUser) {
    return this.messages.send(user, id, body);
  }
}
