import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';

/** FR-037: at most 5 browsers or devices per member. */
export const MAX_PUSH_DEVICES = 5;

const RegisterDeviceSchema = z.strictObject({
  endpoint: z
    .url()
    .max(2048)
    .refine((u) => u.startsWith('https://'), 'must be an https URL'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  label: z.string().trim().max(80).optional(),
});
type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>;
const PauseSchema = z.strictObject({ paused: z.boolean() });

export interface PushDeviceDto {
  id: string;
  label: string | null;
  paused: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
}

function toDto(row: { id: string; label: string; paused: boolean; createdAt: Date; lastSuccessAt: Date | null }): PushDeviceDto {
  return { id: row.id, label: row.label || null, paused: row.paused, createdAt: row.createdAt.toISOString(), lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null };
}

/** "Chrome on Windows" from the browser's User-Agent, when the page sends no label. */
export function labelFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Browser push subscriptions (T086, FR-037, research R9). */
@Injectable()
export class PushDevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<PushDeviceDto[]> {
    const rows = await this.prisma.pushDevice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toDto);
  }

  /**
   * Registers or refreshes this browser. Re-registering the same browser updates its keys and
   * resumes it; a browser registered by another member moves to the caller.
   */
  async register(userId: string, input: RegisterDeviceInput, userAgent: string | undefined): Promise<PushDeviceDto> {
    const label = input.label?.trim() || labelFromUserAgent(userAgent);
    return this.prisma.$transaction(async (tx) => {
      // One registration at a time per member and per browser, so the limit and the unique
      // endpoint hold under concurrent requests. Locks are always taken in this order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`push_devices:user:${userId}`}::text))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`push_devices:endpoint:${input.endpoint}`}::text))`;
      const existing = await tx.pushDevice.findUnique({ where: { endpoint: input.endpoint } });
      const keys = { p256dh: input.keys.p256dh, auth: input.keys.auth };
      if (existing?.userId === userId) {
        return toDto(await tx.pushDevice.update({ where: { id: existing.id }, data: { ...keys, label, paused: false } }));
      }
      if ((await tx.pushDevice.count({ where: { userId } })) >= MAX_PUSH_DEVICES) {
        throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'DEVICE_LIMIT', `You can turn on alerts for at most ${MAX_PUSH_DEVICES} browsers or devices; remove one first`);
      }
      if (existing) await tx.pushDevice.delete({ where: { id: existing.id } });
      return toDto(await tx.pushDevice.create({ data: { userId, endpoint: input.endpoint, ...keys, label } }));
    });
  }

  async setPaused(userId: string, id: string, paused: boolean): Promise<PushDeviceDto> {
    const updated = await this.prisma.pushDevice.updateMany({ where: { id, userId }, data: { paused } });
    if (updated.count === 0) throw AppError.notFound('Device not found');
    return toDto(await this.prisma.pushDevice.findUniqueOrThrow({ where: { id } }));
  }

  async remove(userId: string, id: string): Promise<void> {
    const removed = await this.prisma.pushDevice.deleteMany({ where: { id, userId } });
    if (removed.count === 0) throw AppError.notFound('Device not found');
  }
}

@Controller('me/push-devices')
export class PushDevicesController {
  constructor(private readonly devices: PushDevicesService) {}

  @Get()
  @Require('inbox.view')
  list(@CurrentUser() user: RequestUser) {
    return this.devices.list(user.id);
  }

  @Post()
  @Require('inbox.view')
  register(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(RegisterDeviceSchema)) body: RegisterDeviceInput, @Headers('user-agent') userAgent?: string) {
    return this.devices.register(user.id, body, userAgent);
  }

  @Patch(':id')
  @Require('inbox.view')
  pause(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(PauseSchema)) body: { paused: boolean }) {
    return this.devices.setPaused(user.id, id, body.paused);
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('inbox.view')
  async remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.devices.remove(user.id, id);
  }
}

/** The public VAPID key the browser subscribes with; null while push is not configured. */
@Controller('push')
export class PushKeyController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('vapid-public-key')
  @Require('inbox.view')
  key(): { publicKey: string | null } {
    return { publicKey: this.config.WEB_PUSH_PUBLIC_KEY ?? null };
  }
}
