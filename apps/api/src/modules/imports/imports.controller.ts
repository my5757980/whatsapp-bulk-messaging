import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../common/auth/request-user.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { type UploadedFileData } from '../../common/validation/uploaded-file.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ImportFormSchema, ImportsService, MAX_IMPORT_BYTES, type ImportForm } from './imports.service.js';

/** /imports (T124): contacts imports and campaign audience uploads share the job model. */
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @Require('contacts.manage')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  start(@UploadedFile() file: UploadedFileData | undefined, @Body(new ZodValidationPipe(ImportFormSchema)) body: ImportForm, @CurrentUser() user: RequestUser) {
    return this.imports.start(file, body, user.id);
  }

  @Get(':id')
  @Require('contacts.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.getJob(id);
  }

  /** Streams the row-level error report (FR-010) through the API, behind RBAC. */
  @Get(':id/errors')
  @Require('contacts.manage')
  async errors(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const key = await this.imports.errorReportKey(id);
    const stream = await this.storage.getStream(key);
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="import-${id}-errors.csv"`);
    stream.pipe(res);
  }
}
