import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Encrypts secrets at rest (Meta access tokens) with AES-256-GCM (research R15, Principle III).
 * Format: `<version>:<iv b64>:<auth tag b64>:<ciphertext b64>`. The version prefix allows key rotation.
 */
export class TokenCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keyBase64: string,
    private readonly version = 'v1',
  ) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64');
    }
    this.keys.set(version, key);
  }

  encrypt(plainText: string): string {
    const key = this.keys.get(this.version);
    if (!key) throw new Error(`No key for version ${this.version}`);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [this.version, iv.toString('base64'), tag.toString('base64'), cipherText.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4) throw new Error('Malformed encrypted payload');
    const [version, ivB64, tagB64, cipherB64] = parts as [string, string, string, string];
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown encryption key version "${version}"`);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
