import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { decodeFormToken, encodeFormToken, type FormTokenPayload } from '@wbm/shared';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';

// Form tokens (feature 008 US7, research R12): the flow_token of a sent form names the version, the
// contact and where it was sent, signed with 16 bytes of HMAC-SHA256 under TOKEN_ENCRYPTION_KEY, so an
// answer can be trusted only when the token is ours and unchanged.

@Injectable()
export class FormTokens {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(`form-token:${config.TOKEN_ENCRYPTION_KEY}`);
  }

  private readonly sign = (content: string): string => createHmac('sha256', this.key).update(content).digest().subarray(0, 16).toString('base64url');

  encode(payload: FormTokenPayload): string {
    return encodeFormToken(payload, this.sign);
  }

  /** The payload of a token we signed, or null. */
  decode(token: unknown): FormTokenPayload | null {
    return typeof token === 'string' ? decodeFormToken(token, this.sign) : null;
  }
}
