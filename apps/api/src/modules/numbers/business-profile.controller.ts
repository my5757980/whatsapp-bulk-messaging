import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Require } from '../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../common/auth/request-user.js';
import { MB, type UploadedFileData } from '../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { BusinessProfileInputSchema, BusinessProfileService, type BusinessProfileInput } from './business-profile.service.js';
import { ObaChecklistInputSchema, ObaChecklistService, type ObaChecklistInput } from './oba-checklist.service.js';

/** /numbers/{id}/business-profile (feature 010 US7, contracts/contacts-settings-api.openapi.yaml tag business-profile). */
@Controller('numbers/:id/business-profile')
export class BusinessProfileController {
  constructor(private readonly profiles: BusinessProfileService) {}

  @Get()
  @Require('numbers.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.get(id);
  }

  @Put()
  @Require('numbers.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(BusinessProfileInputSchema)) body: BusinessProfileInput, @CurrentUser() user: RequestUser, @ClientIp() ip: string | null) {
    return this.profiles.update(id, body, { userId: user.id, ip });
  }

  @Post('picture')
  @Require('numbers.manage')
  @HttpCode(200)
  // One byte over 5 MB lets the service answer 422 PICTURE_RULES with the contract's error shape.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * MB + 1, files: 1 } }))
  picture(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileData | undefined, @CurrentUser() user: RequestUser, @ClientIp() ip: string | null) {
    return this.profiles.uploadPicture(id, file, { userId: user.id, ip });
  }
}

/** /oba-checklist (feature 010 US7): the blue tick checklist. */
@Controller('oba-checklist')
export class ObaChecklistController {
  constructor(private readonly checklist: ObaChecklistService) {}

  @Get()
  @Require('numbers.view')
  get() {
    return this.checklist.get();
  }

  @Put()
  @Require('numbers.manage')
  update(@Body(new ZodValidationPipe(ObaChecklistInputSchema)) body: ObaChecklistInput, @CurrentUser() user: RequestUser, @ClientIp() ip: string | null) {
    return this.checklist.update(body, { userId: user.id, ip });
  }
}
