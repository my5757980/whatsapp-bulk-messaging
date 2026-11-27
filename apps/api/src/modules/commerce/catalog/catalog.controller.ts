import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { CatalogService, CommerceSettingsSchema, ConnectSchema, FillSchema, ProductSearchSchema, type ProductSearch } from './catalog.service.js';

/** The catalog routes (feature 008 US5, contracts/commerce-api.openapi.yaml tag catalog). */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get('connection')
  @Require('integrations.manage')
  state() {
    return this.catalog.state();
  }

  @Post('connection')
  @Require('integrations.manage')
  connect(@Body(new ZodValidationPipe(ConnectSchema)) body: z.infer<typeof ConnectSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.catalog.connect(body.catalogId, this.actor(user, req));
  }

  @Delete('connection')
  @HttpCode(204)
  @Require('integrations.manage')
  async disconnect(@CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.catalog.disconnect(this.actor(user, req));
  }

  @Post('sync')
  @HttpCode(202)
  @Require('integrations.manage')
  async sync(): Promise<{ queued: true }> {
    await this.catalog.syncNow();
    return { queued: true };
  }

  @Put('numbers/:id/commerce-settings')
  @Require('integrations.manage')
  settings(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CommerceSettingsSchema)) body: z.infer<typeof CommerceSettingsSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.catalog.setCommerceSettings(id, body, this.actor(user, req));
  }

  @Put('fill')
  @Require('integrations.manage')
  fill(@Body(new ZodValidationPipe(FillSchema)) body: z.infer<typeof FillSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.catalog.setFill(body, this.actor(user, req));
  }

  @Post('fill/run')
  @HttpCode(202)
  @Require('integrations.manage')
  async runFill(): Promise<{ queued: true }> {
    await this.catalog.runFill();
    return { queued: true };
  }

  @Get('products')
  @Require('inbox.view')
  products(@Query(new ZodValidationPipe(ProductSearchSchema)) query: ProductSearch) {
    return this.catalog.search(query);
  }
}
