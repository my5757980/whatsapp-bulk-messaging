import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { SafeHttpError, safeRequest } from '../../../common/http/safe-http.js';

// Shared plumbing for the store integrations (feature 006 US4): calls to the store's API through the
// safe HTTP client, sealed credentials, and the addresses the stores call us on.

export interface ShopifyCredentials {
  /** Dev Dashboard app (client credentials grant). */
  clientId?: string;
  /** Signs webhooks, and with clientId gets access tokens. */
  clientSecret: string;
  /** A legacy custom app's static Admin API token. */
  accessToken?: string;
}

export interface WooCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/** A store answered with an error, or could not be reached; the message is plain text for admins. */
export class StoreApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'StoreApiError';
  }
}

const FAILURE_TEXT: Record<string, string> = {
  BLOCKED_ADDRESS: 'The store address points to a private or local network',
  TIMEOUT: 'The store did not answer in time',
  TOO_LARGE: 'The store sent an answer that is too large',
  REDIRECT: 'The store answered with a redirect; use its final https address',
  NETWORK: 'The store could not be reached',
};

export function plainStoreError(error: unknown): string {
  if (error instanceof StoreApiError) return error.message;
  if (error instanceof SafeHttpError) return FAILURE_TEXT[error.reason] ?? error.message;
  return 'The store could not be reached';
}

@Injectable()
export class StoreHttp {
  constructor(
    private readonly cipher: TokenCipher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get allowLocal(): boolean {
    return this.config.OUTBOUND_ALLOW_LOCAL;
  }

  get shopifyApiVersion(): string {
    return this.config.SHOPIFY_API_VERSION;
  }

  /** Where a store sends its webhooks: the web address proxies /api to this app. */
  receiverUrl(platform: 'shopify' | 'woocommerce', storeId: string): string {
    return `${this.config.APP_URL.replace(/\/+$/, '')}/api/integrations/${platform}/${storeId}/webhooks`;
  }

  seal(value: unknown): string {
    return this.cipher.encrypt(JSON.stringify(value));
  }

  open<T>(sealed: string): T {
    return JSON.parse(this.cipher.decrypt(sealed)) as T;
  }

  /** One JSON call; 401/403 and other errors become a StoreApiError with plain text. */
  async json<T>(input: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; headers?: Record<string, string>; body?: unknown }): Promise<T> {
    const res = await safeRequest({
      method: input.method,
      url: input.url,
      headers: { accept: 'application/json', ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}), ...input.headers },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
      allowLocal: this.allowLocal,
    }).catch((error: unknown) => {
      throw new StoreApiError(plainStoreError(error), null);
    });
    if (res.status === 401 || res.status === 403) throw new StoreApiError('The store refused the access details: check the keys or the app', res.status);
    if (res.status === 404) throw new StoreApiError('The store answered "not found": check the store address', res.status);
    if (res.status >= 400) throw new StoreApiError(`The store answered with an error (${res.status})`, res.status);
    try {
      return (res.text ? JSON.parse(res.text) : {}) as T;
    } catch {
      throw new StoreApiError('The store answered with something that is not JSON', res.status);
    }
  }
}
