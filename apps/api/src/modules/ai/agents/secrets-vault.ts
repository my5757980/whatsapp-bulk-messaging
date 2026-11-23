import { Injectable } from '@nestjs/common';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';

/**
 * Agent secrets for API skill headers (004 T074, FR-030): stored encrypted with 001's TokenCipher,
 * like 003 flow secrets, and decrypted only to fill request headers; an agent reads only its own.
 */
@Injectable()
export class AgentSecretsVault {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
  ) {}

  encrypt(value: string): string {
    return this.cipher.encrypt(value);
  }

  /** Decrypted values of the agent's secrets (only the given ids when ids are passed). */
  async values(agentId: string, ids?: string[]): Promise<Map<string, string>> {
    if (ids && !ids.length) return new Map();
    const rows = await this.prisma.aiAgentSecret.findMany({ where: { agentId, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, valueEncrypted: true } });
    return new Map(rows.map((row) => [row.id, this.cipher.decrypt(row.valueEncrypted)]));
  }
}
