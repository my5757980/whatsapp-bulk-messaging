import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../common/auth/request-user.js';
import { PhoneField } from '../../common/interceptors/phone-mask.interceptor.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import {
  AudiencePreviewSchema,
  BulkActionSchema,
  ContactInputSchema,
  ContactListQuerySchema,
  ContactsService,
  CreateContactSchema,
  type AudiencePreviewInput,
  type BulkAction,
  type ContactInput,
  type ContactListQuery,
} from './contacts.service.js';

/** /contacts (T123, T125). DELETE /contacts/{id} lives in ContactDeletionController (US1). */
@Controller('contacts')
@PhoneField('phone')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @Require('contacts.view')
  list(@Query(new ZodValidationPipe(ContactListQuerySchema)) query: ContactListQuery) {
    return this.contacts.list(query);
  }

  @Post()
  @Require('contacts.manage')
  create(@Body(new ZodValidationPipe(CreateContactSchema)) body: ContactInput & { phone: string }, @CurrentUser() user: RequestUser) {
    return this.contacts.create(body, user.id);
  }

  @Post('bulk')
  @Require('contacts.manage')
  @HttpCode(200)
  bulk(@Body(new ZodValidationPipe(BulkActionSchema)) body: BulkAction) {
    return this.contacts.bulk(body);
  }

  @Post('audience-preview')
  @Require('campaigns.manage')
  @HttpCode(200)
  preview(@Body(new ZodValidationPipe(AudiencePreviewSchema)) body: AudiencePreviewInput) {
    return this.contacts.audiencePreview(body);
  }

  @Get(':id')
  @Require('contacts.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.get(id);
  }

  @Patch(':id')
  @Require('contacts.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ContactInputSchema)) body: ContactInput, @CurrentUser() user: RequestUser) {
    return this.contacts.update(id, body, user.id);
  }
}
