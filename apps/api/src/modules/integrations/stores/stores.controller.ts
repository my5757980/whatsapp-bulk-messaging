import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import type { StoreAutomationKind } from '../../../generated/prisma/client.js';
import {
  AutomationInputSchema,
  CartsQuerySchema,
  KindSchema,
  OrdersQuerySchema,
  ResultsQuerySchema,
  StoreAutomationsService,
  type AutomationInput,
  type CartsQuery,
  type OrdersQuery,
  type StoreResultsQuery,
} from './store-automations.service.js';
import { StoreConnectSchema, StoreConnectionsService, StorePatchSchema, type StoreConnectInput, type StorePatchInput } from './store-connections.service.js';

const kindOf = (raw: string): StoreAutomationKind => {
  const parsed = KindSchema.safeParse(raw);
  if (!parsed.success) throw AppError.notFound('Unknown automation');
  return parsed.data;
};

/** Stores and their automations in the dashboard (feature 006 US4 - US6, contracts/integrations-api.openapi.yaml). */
@Controller('stores')
export class StoresController {
  constructor(
    private readonly stores: StoreConnectionsService,
    private readonly automations: StoreAutomationsService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.stores.list();
  }

  @Post()
  @Require('integrations.manage')
  connect(@Body(new ZodValidationPipe(StoreConnectSchema)) body: StoreConnectInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.stores.connect(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.stores.get(id);
  }

  @Patch(':id')
  @Require('integrations.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(StorePatchSchema)) body: StorePatchInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.stores.update(id, body, this.actor(user, req));
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @Require('integrations.manage')
  disconnect(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.stores.disconnect(id, this.actor(user, req));
  }

  @Post(':id/sync')
  @HttpCode(202)
  @Require('integrations.manage')
  async sync(@Param('id', ParseUUIDPipe) id: string): Promise<{ queued: true }> {
    await this.stores.sync(id);
    return { queued: true };
  }

  @Get(':id/automations/:kind')
  @Require('campaigns.view')
  automation(@Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string) {
    return this.automations.get(id, kindOf(kind));
  }

  @Put(':id/automations/:kind')
  @Require('campaigns.manage')
  saveAutomation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(AutomationInputSchema)) body: AutomationInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.automations.put(id, kindOf(kind), body, this.actor(user, req));
  }

  @Get(':id/automations/:kind/results')
  @Require('campaigns.view')
  results(@Param('id', ParseUUIDPipe) id: string, @Param('kind') kind: string, @Query(new ZodValidationPipe(ResultsQuerySchema)) query: StoreResultsQuery) {
    return this.automations.results(id, kindOf(kind), query);
  }

  @Get(':id/carts')
  @Require('campaigns.view')
  carts(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(CartsQuerySchema)) query: CartsQuery, @CurrentUser() user: RequestUser) {
    return this.automations.carts(id, query, user.role);
  }

  @Get(':id/orders')
  @Require('campaigns.view')
  orders(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(OrdersQuerySchema)) query: OrdersQuery, @CurrentUser() user: RequestUser) {
    return this.automations.orders(id, query, user.role);
  }
}
