import { Injectable, Logger } from '@nestjs/common';

/** One `entry[].changes[]` item of a Meta webhook payload. */
export interface WebhookChange {
  field: string;
  value: Record<string, unknown>;
  /** WhatsApp Business Account id (`entry[].id`). */
  wabaId: string | undefined;
}

export interface WebhookContext {
  webhookEventId: string;
}

export interface WebhookChangeHandler {
  readonly field: string;
  /** Handlers of one field run in ascending order (default 0); live chat runs after consent. */
  readonly order?: number;
  handle(change: WebhookChange, context: WebhookContext): Promise<void>;
}

/** Routes webhook changes by `field` to the handlers registered for it (T062). */
@Injectable()
export class WebhookRouter {
  private readonly logger = new Logger(WebhookRouter.name);
  private readonly handlers = new Map<string, WebhookChangeHandler[]>();

  register(handler: WebhookChangeHandler): void {
    const list = this.handlers.get(handler.field) ?? [];
    list.push(handler);
    // Stable sort: equal orders keep their registration order.
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.handlers.set(handler.field, list);
  }

  async route(payload: unknown, context: WebhookContext): Promise<{ handled: number; ignored: string[] }> {
    const entries = Array.isArray((payload as { entry?: unknown })?.entry)
      ? ((payload as { entry: Array<{ id?: unknown; changes?: unknown }> }).entry)
      : [];
    let handled = 0;
    const ignored: string[] = [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? (entry.changes as Array<{ field?: unknown; value?: unknown }>) : [];
      for (const change of changes) {
        const field = typeof change.field === 'string' ? change.field : '';
        const handlers = this.handlers.get(field);
        if (!handlers?.length) {
          ignored.push(field || '(missing field)');
          continue;
        }
        const value = change.value && typeof change.value === 'object' ? (change.value as Record<string, unknown>) : {};
        for (const handler of handlers) {
          await handler.handle({ field, value, wabaId: typeof entry.id === 'string' ? entry.id : undefined }, context);
          handled++;
        }
      }
    }
    if (ignored.length) this.logger.debug({ ...context, ignored }, 'Webhook changes without a handler');
    return { handled, ignored };
  }
}
