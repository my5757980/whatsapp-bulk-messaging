import { Injectable } from '@nestjs/common';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';

/**
 * Reads flow secrets for API calls (003 T059, FR-015): values are stored encrypted with 001's
 * TokenCipher and decrypted only to fill request headers; a flow reads only its own secrets.
 */
@Injectable()
export class FlowSecretsVault {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
  ) {}

  encrypt(value: string): string {
    return this.cipher.encrypt(value);
  }

  /** Decrypted values of the flow's secrets with these ids. */
  async values(flowId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.flowSecret.findMany({ where: { flowId, id: { in: ids } }, select: { id: true, valueEncrypted: true } });
    return new Map(rows.map((row) => [row.id, this.cipher.decrypt(row.valueEncrypted)]));
  }
}
