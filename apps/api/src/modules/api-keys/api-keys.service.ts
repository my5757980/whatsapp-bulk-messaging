import { randomInt } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { API_KEY_SCOPES, effectiveScopes } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { ApiKey } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { hashToken } from '../auth/auth.service.js';

// API keys for the public API (FR-032, research R16, T185). Format `wbk_` + 32 base62 chars;
// only the SHA-256 hash, an 8-character prefix and the last 4 characters are stored.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const API_KEY_PATTERN = /^wbk_[A-Za-z0-9]{32}$/;

export function generateApiKey(): string {
  let body = '';
  for (let i = 0; i < 32; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `wbk_${body}`;
}

const CreateKeySchema = z
  .object({ name: z.string().trim().min(1).max(60), rateLimitPerMinute: z.number().int().min(1).max(6000).optional() })
  .strict();
type CreateKeyInput = z.infer<typeof CreateKeySchema>;

/** What a key may do (feature 006, FR-010); at least one permission. */
const ScopesSchema = z.object({ scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }).strict();
type ScopesInput = z.infer<typeof ScopesSchema>;

const toDto = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  last4: k.last4,
  rateLimitPerMinute: k.rateLimitPerMinute,
  createdAt: k.createdAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  scopes: effectiveScopes(k.scopes),
});

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } })).map(toDto);
  }

  /** Returns the full secret once; it cannot be recovered afterwards. */
  async create(input: CreateKeyInput, actor: AuditActor & { userId: string }) {
    const secret = generateApiKey();
    const key = await this.prisma.apiKey.create({
      data: {
        name: input.name,
        prefix: secret.slice(0, 8),
        keyHash: hashToken(secret),
        last4: secret.slice(-4),
        rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
        createdById: actor.userId,
      },
    });
    await this.audit.record(actor, 'api_key.created', { type: 'api_key', id: key.id }, { name: key.name, rateLimitPerMinute: key.rateLimitPerMinute });
    return { ...toDto(key), secret };
  }

  /** Sets what a key may do (feature 006, FR-010); audited with the before and after lists. */
  async setScopes(id: string, input: ScopesInput, actor: AuditActor) {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('API key not found');
    const scopes = API_KEY_SCOPES.filter((s) => input.scopes.includes(s));
    const updated = await this.prisma.apiKey.update({ where: { id }, data: { scopes } });
    await this.audit.record(actor, 'api_key.scopes_changed', { type: 'api_key', id }, { name: key.name, from: effectiveScopes(key.scopes), to: scopes });
    return { id, scopes: effectiveScopes(updated.scopes) };
  }

  async revoke(id: string, actor: AuditActor): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw AppError.notFound('API key not found');
    if (key.revokedAt) return;
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record(actor, 'api_key.revoked', { type: 'api_key', id }, { name: key.name });
  }
}

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @Require('apikeys.manage')
  list() {
    return this.keys.list();
  }

  @Post()
  @Require('apikeys.manage')
  create(@Body(new ZodValidationPipe(CreateKeySchema)) body: CreateKeyInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.keys.create(body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Put(':id/scopes')
  @Require('apikeys.manage')
  setScopes(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ScopesSchema)) body: ScopesInput, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.keys.setScopes(id, body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Delete(':id')
  @Require('apikeys.manage')
  @HttpCode(204)
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.keys.revoke(id, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
