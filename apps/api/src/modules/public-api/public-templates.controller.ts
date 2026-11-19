import { Controller, Get, UseGuards } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { PublicApiService } from './public-api.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

/** GET /api/v1/templates (T190): approved templates and their variable keys. */
@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class PublicTemplatesController {
  constructor(private readonly api: PublicApiService) {}

  @Get('templates')
  templates() {
    return this.api.templates();
  }
}
