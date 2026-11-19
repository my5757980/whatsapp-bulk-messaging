import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ConnectNumberSchema, NumbersService, UpdateNumberSchema, type ConnectNumberInput, type UpdateNumberInput } from './numbers.service.js';

/** /numbers (T086). `accessToken` is write-only: accepted on POST/PATCH, never returned. */
@Controller('numbers')
export class NumbersController {
  constructor(private readonly numbers: NumbersService) {}

  @Get()
  @Require('numbers.view')
  list() {
    return this.numbers.list();
  }

  @Post()
  @Require('numbers.manage')
  connect(
    @Body(new ZodValidationPipe(ConnectNumberSchema)) body: ConnectNumberInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.numbers.connect(body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Get(':id')
  @Require('numbers.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.numbers.get(id);
  }

  @Patch(':id')
  @Require('numbers.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateNumberSchema)) body: UpdateNumberInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.numbers.update(id, body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Delete(':id')
  @Require('numbers.manage')
  @HttpCode(204)
  async disconnect(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.numbers.disconnect(id, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Post(':id/refresh')
  @Require('numbers.view')
  @HttpCode(200)
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.numbers.refresh(id);
  }
}
