import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import {
  DeliveryListQuerySchema,
  WebhookEndpointInputSchema,
  WebhookEndpointPatchSchema,
  WebhookEndpointsService,
  type DeliveryListQuery,
  type WebhookEndpointInput,
  type WebhookEndpointPatch,
} from './webhook-endpoints.service.js';

/** Webhook endpoints and their delivery log (contracts/integrations-api.openapi.yaml, tag webhooks). Admins only. */
@Controller()
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get('webhook-event-types')
  @Require('integrations.manage')
  eventTypes() {
    return this.endpoints.eventTypes();
  }

  @Get('webhook-endpoints')
  @Require('integrations.manage')
  list() {
    return this.endpoints.list();
  }

  @Post('webhook-endpoints')
  @Require('integrations.manage')
  create(@Body(new ZodValidationPipe(WebhookEndpointInputSchema)) body: WebhookEndpointInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.create(body, this.actor(user, req));
  }

  @Get('webhook-endpoints/:id')
  @Require('integrations.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.endpoints.get(id);
  }

  @Patch('webhook-endpoints/:id')
  @Require('integrations.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(WebhookEndpointPatchSchema)) body: WebhookEndpointPatch,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.endpoints.update(id, body, this.actor(user, req));
  }

  @Delete('webhook-endpoints/:id')
  @Require('integrations.manage')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.endpoints.remove(id, this.actor(user, req));
  }

  @Post('webhook-endpoints/:id/pause')
  @Require('integrations.manage')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.pause(id, this.actor(user, req));
  }

  @Post('webhook-endpoints/:id/resume')
  @Require('integrations.manage')
  @HttpCode(200)
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.resume(id, this.actor(user, req));
  }

  @Post('webhook-endpoints/:id/renew-secret')
  @Require('integrations.manage')
  @HttpCode(200)
  renewSecret(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.renewSecret(id, this.actor(user, req));
  }

  @Post('webhook-endpoints/:id/test')
  @Require('integrations.manage')
  @HttpCode(200)
  test(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.test(id, this.actor(user, req));
  }

  @Get('webhook-endpoints/:id/deliveries')
  @Require('integrations.manage')
  deliveries(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(DeliveryListQuerySchema)) query: DeliveryListQuery) {
    return this.endpoints.deliveriesOf(id, query);
  }

  @Post('webhook-deliveries/:id/resend')
  @Require('integrations.manage')
  @HttpCode(202)
  resend(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.endpoints.resend(id, this.actor(user, req));
  }
}
