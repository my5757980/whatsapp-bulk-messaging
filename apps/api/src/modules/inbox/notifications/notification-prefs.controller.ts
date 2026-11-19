import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';

export const PreferencesSchema = z.strictObject({ soundEnabled: z.boolean() });

/** The caller's new-message sound (T086, FR-037); the row is created on first save. */
@Controller('me/notification-preferences')
export class NotificationPrefsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('inbox.view')
  async get(@CurrentUser() user: RequestUser): Promise<{ soundEnabled: boolean }> {
    const row = await this.prisma.notificationPreference.findUnique({ where: { userId: user.id } });
    return { soundEnabled: row?.soundEnabled ?? true };
  }

  @Put()
  @Require('inbox.view')
  async put(@CurrentUser() user: RequestUser, @Body(new ZodValidationPipe(PreferencesSchema)) body: { soundEnabled: boolean }): Promise<{ soundEnabled: boolean }> {
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, soundEnabled: body.soundEnabled },
      update: { soundEnabled: body.soundEnabled },
    });
    return { soundEnabled: row.soundEnabled };
  }
}
