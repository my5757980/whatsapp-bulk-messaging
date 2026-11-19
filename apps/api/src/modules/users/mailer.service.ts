import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';

/**
 * Optional e-mail (T172). With `SMTP_URL` set, invitations are e-mailed through nodemailer;
 * otherwise this is a no-op and admins share the invitation link themselves.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : null;
    this.from = `WhatsApp Bulk Messaging <no-reply@${new URL(config.APP_URL).hostname}>`;
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  /** Returns true when the e-mail was handed to the SMTP server. */
  async sendInvitation(to: string, inviteUrl: string, details: { inviterName: string; role: string }): Promise<boolean> {
    if (!this.transport) {
      this.logger.log('SMTP is not configured; the invitation link must be shared manually');
      return false;
    }
    try {
      await this.transport.sendMail({
        from: this.from,
        to,
        subject: 'You are invited to WhatsApp Bulk Messaging',
        text: [
          `${details.inviterName} invited you to join as ${details.role.toLowerCase()}.`,
          '',
          'Open this link within 7 days to choose your password:',
          inviteUrl,
          '',
          'If you did not expect this e-mail, you can ignore it.',
        ].join('\n'),
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'Invitation e-mail could not be sent');
      return false;
    }
  }
}
