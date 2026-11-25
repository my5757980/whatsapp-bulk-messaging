// Feature 006 US8 (T078): the Graph routes of the number connection wizard (research R13), answered for
// the wizard tokens only, so the routes for "mock-token" are unchanged.
//   mock-token-ok             both permissions, never expires
//   mock-token-missing-scope  no whatsapp_business_messaging
//   mock-token-expiring       both permissions, expires in 3 days
// The account MOCK_WIZARD_WABA has one number, not registered until POST /register with PIN 123456,
// and not subscribed to the app until POST /subscribed_apps. A template sent from the number gets
// sent and delivered status webhooks.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { postSigned, statusPayload } from './webhook-emitter.js';

export const WIZARD_TOKENS = { ok: 'mock-token-ok', missingScope: 'mock-token-missing-scope', expiring: 'mock-token-expiring' } as const;
export const WIZARD_WABA = 'MOCK_WIZARD_WABA';
export const WIZARD_PHONE = '990000000001';
export const WIZARD_PIN = '123456';
const APP_ID = process.env.META_APP_ID || '1234567890';
const CALLBACK = process.env.MOCK_WIZARD_CALLBACK_URL ?? `${(process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')}/api/webhooks/meta`;
const BOTH = ['whatsapp_business_management', 'whatsapp_business_messaging'];

const registered = new Set<string>();
const subscribed = new Set<string>();
let counter = 0;

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function graphError(res: ServerResponse, status: number, code: number, message: string): true {
  return send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'MOCKWIZARD' } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const wizardToken = (token: string) => (Object.values(WIZARD_TOKENS) as string[]).includes(token);
const appToken = (token: string) => /^[0-9]+\|.+$/.test(token);

function debugData(input: string) {
  const granted = (scopes: string[]) => scopes.map((scope) => ({ scope, target_ids: [WIZARD_WABA] }));
  switch (input) {
    case WIZARD_TOKENS.ok:
      return { app_id: APP_ID, type: 'SYSTEM_USER', application: 'Mock app', is_valid: true, expires_at: 0, scopes: [...BOTH, 'business_management'], granular_scopes: granted(BOTH) };
    case WIZARD_TOKENS.missingScope:
      return { app_id: APP_ID, type: 'SYSTEM_USER', application: 'Mock app', is_valid: true, expires_at: 0, scopes: [BOTH[0]], granular_scopes: granted([BOTH[0]!]) };
    case WIZARD_TOKENS.expiring:
      return { app_id: APP_ID, type: 'USER', application: 'Mock app', is_valid: true, expires_at: Math.floor(Date.now() / 1000) + 3 * 86_400, scopes: BOTH, granular_scopes: granted(BOTH) };
    default:
      return { is_valid: false, scopes: [], error: { code: 190, message: 'Invalid OAuth access token.' } };
  }
}

function phone() {
  return {
    id: WIZARD_PHONE,
    display_phone_number: '+1 555 019 9001',
    verified_name: 'Mock Wizard Business',
    name_status: 'APPROVED',
    status: 'CONNECTED',
    code_verification_status: 'VERIFIED',
    quality_rating: 'GREEN',
    platform_type: registered.has(WIZARD_PHONE) ? 'CLOUD_API' : 'NOT_APPLICABLE',
    throughput: { level: 'STANDARD' },
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
  };
}

const later = (ms: number, fn: () => Promise<unknown>) => setTimeout(() => void fn(), ms);

/** True when the request was a wizard route and has been answered. */
export async function handleWizard(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const [version, id, resource] = url.pathname.split('/').filter(Boolean);
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!version?.startsWith('v') || !id || !token) return false;

  if (req.method === 'GET' && id === 'debug_token') {
    if (!wizardToken(token) && !appToken(token)) return false;
    return send(res, 200, { data: debugData(url.searchParams.get('input_token') ?? '') });
  }
  if (req.method === 'GET' && id === APP_ID && resource === 'subscriptions' && (appToken(token) || wizardToken(token))) {
    return send(res, 200, { data: [{ object: 'whatsapp_business_account', callback_url: CALLBACK, active: true, fields: [{ name: 'messages', version }] }] });
  }
  if (!wizardToken(token) || (id !== WIZARD_WABA && id !== WIZARD_PHONE)) return false;
  if (token === WIZARD_TOKENS.missingScope && req.method === 'POST' && resource === 'messages') return graphError(res, 403, 200, 'Requires whatsapp_business_messaging permission');

  if (id === WIZARD_WABA) {
    if (req.method === 'GET' && !resource) return send(res, 200, { id, name: 'Mock Wizard Account', currency: 'USD', timezone_id: '1' });
    if (req.method === 'GET' && resource === 'phone_numbers') return send(res, 200, { data: [phone()], paging: { cursors: {} } });
    if (req.method === 'GET' && resource === 'message_templates') {
      return send(res, 200, {
        data: [{ id: 'MOCKWIZTPL1', name: 'hello_world', language: 'en_US', category: 'UTILITY', status: 'APPROVED', parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hello World' }] }],
        paging: { cursors: {} },
      });
    }
    if (req.method === 'GET' && resource === 'subscribed_apps') {
      return send(res, 200, { data: subscribed.has(id) ? [{ whatsapp_business_api_data: { id: APP_ID, name: 'Mock app', link: 'https://mock.example' } }] : [] });
    }
    if (req.method === 'POST' && resource === 'subscribed_apps') {
      subscribed.add(id);
      return send(res, 200, { success: true });
    }
    return graphError(res, 404, 100, 'Unknown wizard path');
  }

  if (req.method === 'GET' && !resource) return send(res, 200, phone());
  if (req.method === 'POST' && resource === 'register') {
    const body = await readJson(req);
    if (body.messaging_product !== 'whatsapp') return graphError(res, 400, 100, 'messaging_product is required');
    if (body.pin !== WIZARD_PIN) return graphError(res, 400, 133005, 'Two step verification PIN Mismatch');
    registered.add(id);
    return send(res, 200, { success: true });
  }
  if (req.method === 'POST' && resource === 'messages') {
    const body = await readJson(req);
    if (!registered.has(id)) return graphError(res, 400, 133010, 'Phone number not registered');
    const to = String(body.to ?? '');
    const wamid = `wamid.MOCKWIZ${Date.now()}${(counter++).toString().padStart(4, '0')}`;
    later(400, () => postSigned(statusPayload({ wabaId: WIZARD_WABA, phoneNumberId: id, wamid, recipient: to, status: 'sent', category: 'utility' })));
    later(900, () => postSigned(statusPayload({ wabaId: WIZARD_WABA, phoneNumberId: id, wamid, recipient: to, status: 'delivered', category: 'utility' })));
    return send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] });
  }
  return graphError(res, 404, 100, 'Unknown wizard path');
}
