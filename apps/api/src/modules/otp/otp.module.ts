import { Module } from '@nestjs/common';
import { OtpSettingsController, PublicOtpController } from './otp.controllers.js';
import { OtpService } from './otp.service.js';

/** One-time codes (feature 009 US1): the public API and the settings (HTTP app only). */
@Module({
  providers: [OtpService],
  controllers: [PublicOtpController, OtpSettingsController],
})
export class OtpApiModule {}
