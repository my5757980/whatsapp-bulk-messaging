import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { TemplateFormTokensPort } from '../../sending/template-form-tokens.port.js';
import { FormTokens } from './form-tokens.js';

// The form token of a template message's FLOW button (feature 008 US7): the form version that published
// that Meta flow, the recipient, and the message as the reference ("message").

@Injectable()
export class TemplateFormTokens implements TemplateFormTokensPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: FormTokens,
  ) {}

  async forMessage(messageId: string, contactId: string, metaFlowId: string): Promise<string | null> {
    const [version] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM form_versions WHERE meta_flows @> ${JSON.stringify([{ flowId: metaFlowId }])}::jsonb ORDER BY published_at DESC LIMIT 1`;
    return version ? this.tokens.encode({ versionId: version.id, contactId, ref: 'message', refId: messageId }) : null;
  }
}
