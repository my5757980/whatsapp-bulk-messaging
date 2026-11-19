import { Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Require } from '../../common/auth/permissions.guard.js';
import { MB, type UploadedFileData } from '../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { MediaService, MediaUploadSchema, type MediaUploadInput } from './media.service.js';

/** POST /media (T090). */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @Require('templates.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * MB, files: 1 } }))
  upload(@UploadedFile() file: UploadedFileData | undefined, @Body(new ZodValidationPipe(MediaUploadSchema)) body: MediaUploadInput) {
    return this.media.create(file, body);
  }
}
