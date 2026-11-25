import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/public.decorator.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { ApiKeyGuard, type ApiKeyContext, type ApiRequest } from './api-key.guard.js';
import { RequireScope } from './api-scope.decorator.js';
import { IdempotentResponses, type Answer } from './idempotent-responses.service.js';
import {
  ContactListQuerySchema,
  ContactPatchSchema,
  ContactUpsertSchema,
  OptInSchema,
  PublicContactsService,
  TagsInputSchema,
  type ContactListQuery,
  type ContactPatch,
  type ContactUpsert,
  type OptInInput,
  type TagsInput,
} from './public-contacts.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

export const keyOf = (req: ApiRequest): ApiKeyContext => {
  if (!req.apiKey) throw AppError.unauthorized('Missing or invalid API key');
  return req.apiKey;
};

/** Runs a changing request once per Idempotency-Key (FR-015) and answers with its status. */
export async function answerOnce<T>(
  idempotent: IdempotentResponses,
  req: ApiRequest,
  res: Response,
  idempotencyKey: string | undefined,
  body: unknown,
  work: () => Promise<Answer<T>>,
): Promise<T> {
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  const answer = await idempotent.run(keyOf(req).id, idempotencyKey, { method: req.method, path, body }, work);
  res.status(answer.status);
  return answer.body;
}

/** An id in the path that is not a uuid is "not found", as in the 001 messages route. */
const contactId = (id: string): string => {
  if (!z.uuid().safeParse(id).success) throw AppError.notFound('Contact not found');
  return id;
};

/** Contacts, tags and attributes through the public API (feature 006 US2, contracts/public-api-v1.openapi.yaml). */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PublicContactsController {
  constructor(
    private readonly contacts: PublicContactsService,
    private readonly idempotent: IdempotentResponses,
  ) {}

  @Get('contacts')
  @RequireScope('contacts.read')
  list(@Query(new ZodValidationPipe(ContactListQuerySchema)) query: ContactListQuery) {
    return this.contacts.list(query);
  }

  // Declared before contacts/:id so "lookup" is not read as an id.
  @Get('contacts/lookup')
  @RequireScope('contacts.read')
  lookup(@Query('phone') phone: string | undefined) {
    if (!phone?.trim()) throw AppError.validation('Give the phone number to look up', [{ field: 'phone', issue: 'is required' }]);
    return this.contacts.lookup(phone);
  }

  @Get('contacts/:id')
  @RequireScope('contacts.read')
  get(@Param('id') id: string) {
    return this.contacts.get(contactId(id));
  }

  @Post('contacts')
  @RequireScope('contacts.write')
  upsert(
    @Body(new ZodValidationPipe(ContactUpsertSchema)) body: ContactUpsert,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, () => this.contacts.upsert(body, keyOf(req)));
  }

  @Patch('contacts/:id')
  @RequireScope('contacts.write')
  patch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ContactPatchSchema)) body: ContactPatch,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, async () => ({ status: 200, body: await this.contacts.patch(contactId(id), body, keyOf(req)) }));
  }

  @Post('contacts/:id/tags')
  @RequireScope('contacts.write')
  addTags(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TagsInputSchema)) body: TagsInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, async () => ({ status: 200, body: await this.contacts.addTags(contactId(id), body.tags, keyOf(req)) }));
  }

  @Delete('contacts/:id/tags/:tag')
  @RequireScope('contacts.write')
  removeTag(
    @Param('id') id: string,
    @Param('tag') tag: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, {}, async () => ({ status: 200, body: await this.contacts.removeTag(contactId(id), tag, keyOf(req)) }));
  }

  @Post('contacts/:id/opt-in')
  @RequireScope('contacts.write')
  optIn(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(OptInSchema)) body: OptInInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, async () => ({ status: 200, body: await this.contacts.optIn(contactId(id), body.sourceNote, keyOf(req)) }));
  }

  @Post('contacts/:id/opt-out')
  @HttpCode(200)
  @RequireScope('contacts.write')
  optOut(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, {}, async () => ({ status: 200, body: await this.contacts.optOut(contactId(id), keyOf(req)) }));
  }

  @Get('tags')
  @RequireScope('contacts.read')
  tags() {
    return this.contacts.tags();
  }

  @Get('attributes')
  @RequireScope('contacts.read')
  attributes() {
    return this.contacts.attributes();
  }
}
