import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import QRCode from 'qrcode';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { SettingsService } from '../settings/settings.service.js';

// Feature 009 (research R16, FR-045): a WhatsApp link and QR code for any number and message. Nothing is
// stored; for a connected number of the company, "Save as chat link" can open the 006 form.

const LinkSchema = z.object({ phone: z.string().trim().min(1).max(32), message: z.string().max(500).optional() }).strict();
type LinkInput = z.infer<typeof LinkSchema>;

const digits = (value: string) => value.replace(/\D/g, '');

@Controller('tools')
export class WhatsappLinkController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Post('whatsapp-link')
  @Require('templates.view')
  @HttpCode(200)
  async make(@Body(new ZodValidationPipe(LinkSchema)) body: LinkInput) {
    const { defaultCountryCode } = await this.settings.get();
    const phone = normalizePhone(body.phone, defaultCountryCode);
    if (!phone) throw AppError.validation('Enter a valid phone number, with the country code', [{ field: 'phone', issue: 'not a valid phone number' }], 'INVALID_NUMBER');
    const text = body.message?.trim() ?? '';
    const url = `https://wa.me/${digits(phone.e164)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
    const options = { margin: 2, errorCorrectionLevel: 'M' as const };
    const [qrPng, qrSvg] = await Promise.all([QRCode.toDataURL(url, { ...options, width: 512 }), QRCode.toString(url, { ...options, type: 'svg' })]);
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: 'CONNECTED' }, select: { id: true, displayPhoneNumber: true } });
    const connected = numbers.find((n) => digits(n.displayPhoneNumber) === digits(phone.e164));
    return { url, qrPng, qrSvg, connectedNumberId: connected?.id ?? null };
  }
}
