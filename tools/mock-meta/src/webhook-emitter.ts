import { createHmac } from 'node:crypto';
import { env } from './env.js';

// Builds and posts Meta-shaped, signed webhook payloads to the API (T064).

export interface StatusEvent {
  wabaId: string;
  phoneNumberId: string;
  wamid: string;
  recipient: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  category?: string;
  error?: { code: number; title: string; message: string };
}

const unix = () => String(Math.floor(Date.now() / 1000));

function envelope(wabaId: string, field: string, value: Record<string, unknown>) {
  return { object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ field, value }] }] };
}

export async function postSigned(payload: unknown): Promise<number> {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', env.appSecret).update(raw).digest('hex')}`;
  try {
    const res = await fetch(env.webhookTarget, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    return res.status;
  } catch (error) {
    console.warn(`mock-meta: webhook post failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

export function statusPayload(e: StatusEvent) {
  const status: Record<string, unknown> = {
    id: e.wamid,
    status: e.status,
    timestamp: unix(),
    recipient_id: e.recipient,
  };
  if (e.status !== 'failed') {
    status.pricing = { billable: true, pricing_model: 'PMP', category: (e.category ?? 'marketing').toLowerCase() };
  }
  if (e.error) {
    status.errors = [{ code: e.error.code, title: e.error.title, message: e.error.message, error_data: { details: e.error.message } }];
  }
  return envelope(e.wabaId, 'messages', {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550100', phone_number_id: e.phoneNumberId },
    statuses: [status],
  });
}

export function inboundPayload(args: { wabaId: string; phoneNumberId: string; from: string; text: string }) {
  return envelope(args.wabaId, 'messages', {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550100', phone_number_id: args.phoneNumberId },
    contacts: [{ profile: { name: 'Mock Customer' }, wa_id: args.from }],
    messages: [{ from: args.from, id: `wamid.in.${Date.now()}`, timestamp: unix(), type: 'text', text: { body: args.text } }],
  });
}

export function templateStatusPayload(args: { wabaId: string; id: string; name: string; language: string; event: string; reason?: string }) {
  return envelope(args.wabaId, 'message_template_status_update', {
    event: args.event,
    message_template_id: args.id,
    message_template_name: args.name,
    message_template_language: args.language,
    reason: args.reason ?? 'NONE',
  });
}

export function qualityPayload(args: { wabaId: string; displayPhoneNumber: string; event: string; currentLimit?: string }) {
  return envelope(args.wabaId, 'phone_number_quality_update', {
    display_phone_number: args.displayPhoneNumber,
    event: args.event,
    current_limit: args.currentLimit ?? 'TIER_1K',
  });
}
