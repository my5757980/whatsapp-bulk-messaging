import { Injectable, Logger } from '@nestjs/common';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { MetaGraphClient } from '../../meta/meta-graph.client.js';

/**
 * Tells WhatsApp the customer's latest message was read (T033, contracts/meta-graph-inbox.md §4).
 * Best effort: failures are logged and never shown to members.
 */
@Injectable()
export class ReadReceiptProcessor {
  private readonly logger = new Logger(ReadReceiptProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly cipher: TokenCipher,
  ) {}

  async process(conversationId: string): Promise<void> {
    const latest = await this.prisma.chatMessage.findFirst({
      where: { conversationId, kind: 'INBOUND', waMessageId: { not: null } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { waMessageId: true, conversation: { select: { number: { select: { phoneNumberId: true, accessTokenEnc: true, connectionStatus: true } } } } },
    });
    if (!latest?.waMessageId || latest.conversation.number.connectionStatus !== 'CONNECTED') return;
    const { number } = latest.conversation;
    try {
      await this.meta.markRead(this.cipher.decrypt(number.accessTokenEnc), number.phoneNumberId, latest.waMessageId);
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, conversationId }, 'Read receipt was not accepted');
    }
  }
}
