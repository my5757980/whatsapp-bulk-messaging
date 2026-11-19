import webpush from 'web-push';
import type { AppConfig } from '../../../common/config/config.js';

// The browser push transport (T087, research R9). Tests replace it with a fake through the
// PUSH_SENDER token, so no real push service is called.

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  /** False until all three VAPID settings are present; alerts are then skipped. */
  readonly enabled: boolean;
  /** Rejects with an error carrying `statusCode` when the push service refuses the message. */
  send(target: PushTarget, payload: string, options: { TTL: number }): Promise<unknown>;
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** A push service waits at most this long for the socket before the attempt is dropped. */
const PUSH_TIMEOUT_MS = 10_000;

export function createPushSender(config: AppConfig): PushSender {
  const { WEB_PUSH_PUBLIC_KEY: publicKey, WEB_PUSH_PRIVATE_KEY: privateKey, WEB_PUSH_SUBJECT: subject } = config;
  if (!publicKey || !privateKey || !subject) {
    return { enabled: false, send: () => Promise.reject(new Error('Browser push is not configured')) };
  }
  const vapidDetails = { subject, publicKey, privateKey };
  return {
    enabled: true,
    send: (target, payload, options) => webpush.sendNotification(target, payload, { ...options, vapidDetails, timeout: PUSH_TIMEOUT_MS }),
  };
}
