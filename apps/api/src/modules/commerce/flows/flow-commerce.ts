import { Injectable } from '@nestjs/common';
import { notSendableReason } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { FlowCommerceMessage, FlowCommercePort } from '../../flows/engine/ports.js';
import { CatalogService, productDto } from '../catalog/catalog.service.js';
import { FormTokens } from '../forms/form-tokens.js';

// Commerce steps of chatbot flows (feature 008 US8, R10 – R12): the chat item of a product, product
// list, catalog or form message sent by a flow. A form is signed for the session ("session" token), so
// its answer resumes the flow; products that cannot be sent, a missing catalog or an unpublished form
// give no item and the step waits for its timeout.

type MetaFlow = { wabaId: string; flowId: string | null; status: string };

@Injectable()
export class FlowCommerce implements FlowCommercePort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly tokens: FormTokens,
  ) {}

  async itemFor(message: FlowCommerceMessage, ctx: { contactId: string | null; sessionId: string; numberId: string }) {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: ctx.numberId }, select: { wabaId: true } });
    if (!number) return null;
    if (message.type === 'form') {
      if (!ctx.contactId) return null;
      const form = await this.prisma.form.findUnique({ where: { id: message.formId } });
      const version = form?.status === 'PUBLISHED' && form.currentVersionId ? await this.prisma.formVersion.findUnique({ where: { id: form.currentVersionId } }) : null;
      const flow = version ? ((Array.isArray(version.metaFlows) ? version.metaFlows : []) as unknown as MetaFlow[]).find((f) => f.wabaId === number.wabaId && f.status === 'PUBLISHED' && f.flowId) : undefined;
      if (!form || !version || !flow) return null;
      const token = this.tokens.encode({ versionId: version.id, contactId: ctx.contactId, ref: 'session', refId: ctx.sessionId });
      return {
        contentType: 'FORM' as const,
        text: message.body || form.name,
        payload: { formId: form.id, formName: form.name, versionId: version.id, flowId: flow.flowId, cta: message.cta || 'Open form', token, ...(message.header ? { header: message.header } : {}) },
      };
    }
    const connection = await this.catalog.connection();
    if (!connection || !(await this.catalog.ensureNumberHasCatalog(connection, number.wabaId))) return null;
    const ids = message.type === 'products' ? message.sections.flatMap((s) => s.retailerIds) : message.thumbnailRetailerId ? [message.thumbnailRetailerId] : [];
    const products = ids.length ? await this.prisma.catalogProduct.findMany({ where: { retailerId: { in: ids } } }) : [];
    const byId = new Map(products.map((p) => [p.retailerId, p]));
    if (ids.some((id) => !byId.has(id) || notSendableReason(byId.get(id)!) !== null)) return null;
    const summaries = ids.map((id) => {
      const p = productDto(byId.get(id)!);
      return { retailerId: p.retailerId, name: p.name, priceMinor: p.salePriceMinor ?? p.priceMinor, currency: p.currency, imageUrl: p.imageUrl };
    });
    const footer = message.footer ? { footer: message.footer } : {};
    if (message.type === 'catalog') {
      return { contentType: 'CATALOG' as const, text: message.body, payload: { catalogId: connection.catalogId, thumbnailRetailerId: message.thumbnailRetailerId, products: summaries, ...footer } };
    }
    if (ids.length === 1) {
      return { contentType: 'PRODUCT' as const, text: message.body || null, payload: { catalogId: connection.catalogId, retailerId: ids[0], products: summaries, ...footer } };
    }
    return {
      contentType: 'PRODUCT_LIST' as const,
      text: message.body,
      payload: { catalogId: connection.catalogId, header: message.header, sections: message.sections.map((s) => ({ title: s.title || null, retailerIds: s.retailerIds })), products: summaries, ...footer },
    };
  }
}
