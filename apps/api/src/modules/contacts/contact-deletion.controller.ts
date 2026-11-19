import { Controller, Delete, HttpCode, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { ContactDeletionService } from './contact-deletion.service.js';

/** DELETE /contacts/{id} (T103), admin only via `contacts.delete`. */
@Controller('contacts')
export class ContactDeletionController {
  constructor(private readonly deletion: ContactDeletionService) {}

  @Delete(':id')
  @Require('contacts.delete')
  @HttpCode(204)
  async delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.deletion.delete(id, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
