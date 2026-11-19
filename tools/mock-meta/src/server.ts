// Fake Meta Graph API for local development and e2e tests (T063, constitution Principle V).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env } from './env.js';
import { postSigned, statusPayload, templateStatusPayload } from './webhook-emitter.js';

interface MockTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameter_format: string;
  components: unknown[];
}

interface SentMessage {
  wamid: string;
  phoneNumberId: string;
  to: string;
  template: string;
  at: string;
}

const templates = new Map<string, MockTemplate[]>(); // wabaId -> templates
const sent: SentMessage[] = [];

/** Category of a template by name (Meta's pricing category follows the template category). */
const templateCategory = (name: string): string | undefined => [...templates.values()].flat().find((t) => t.name === name)?.category;
let counter = 0;
const nextId = (prefix: string) => `${prefix}${Date.now()}${(counter++).toString().padStart(4, '0')}`;

function seedTemplates(wabaId: string): MockTemplate[] {
  let list = templates.get(wabaId);
  if (!list) {
    list = [
      {
        id: nextId('T'),
        name: 'order_confirmation',
        language: 'en_US',
        category: 'UTILITY',
        status: 'APPROVED',
        parameter_format: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is confirmed.', example: { body_text: [['Sara', '#10234']] } },
        ],
      },
      {
        id: nextId('T'),
        name: 'summer_sale',
        language: 'en_US',
        category: 'MARKETING',
        status: 'APPROVED',
        parameter_format: 'POSITIONAL',
        components: [
          { type: 'BODY', text: 'Hello {{1}}! Our summer sale starts today.', example: { body_text: [['Sara']] } },
          { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/{{1}}', example: ['summer'] }] },
        ],
      },
    ];
    templates.set(wabaId, list);
  }
  return list;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function graphError(res: ServerResponse, status: number, code: number, message: string): void {
  send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: nextId('trace') } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const later = (ms: number, fn: () => Promise<unknown>) => setTimeout(() => void fn(), ms);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${env.port}`);
  const [version, id, resource] = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/mock/sent') return send(res, 200, { count: sent.length, messages: sent });
  if (!version?.startsWith('v') || !id) return graphError(res, 404, 100, 'Unknown path');

  // Graph accepts "Bearer <token>"; the resumable upload data call uses "OAuth <token>".
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${env.token}` && auth !== `OAuth ${env.token}`) {
    return graphError(res, 401, 190, 'Invalid OAuth access token');
  }

  // Resumable Upload API (template header samples): POST /{ver}/{appId}/uploads -> { id: "upload:..." }
  if (req.method === 'POST' && resource === 'uploads') {
    if (!url.searchParams.get('file_length') || !url.searchParams.get('file_type')) return graphError(res, 400, 100, 'Missing file_length or file_type');
    return send(res, 200, { id: `upload:${nextId('S')}` });
  }
  // POST /{ver}/upload:<session> with the file bytes and file_offset: 0 -> { h: "<handle>" }
  if (req.method === 'POST' && id.startsWith('upload:') && !resource) {
    await readBody(req);
    if (req.headers.file_offset !== '0') return graphError(res, 400, 100, 'file_offset header is required');
    return send(res, 200, { h: `4::${Buffer.from(nextId('H')).toString('base64')}` });
  }

  // GET /{ver}/{phoneNumberId}
  if (req.method === 'GET' && !resource) {
    return send(res, 200, {
      id,
      display_phone_number: '+1 555 010 0000',
      verified_name: 'Mock Business',
      quality_rating: 'GREEN',
      code_verification_status: 'VERIFIED',
      status: 'CONNECTED',
      throughput: { level: 'STANDARD' },
    });
  }

  // POST /{ver}/{phoneNumberId}/messages
  if (req.method === 'POST' && resource === 'messages') {
    const body = JSON.parse((await readBody(req)) || '{}') as { to?: string; template?: { name?: string } };
    if (!body.to || !body.template?.name) return graphError(res, 400, 100, 'Missing to or template');
    const wamid = `wamid.${nextId('M')}`;
    sent.push({ wamid, phoneNumberId: id, to: body.to, template: body.template.name, at: new Date().toISOString() });
    const wabaId = 'MOCK_WABA';
    if (body.to.endsWith('0000')) {
      later(500, () =>
        postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: body.to!, status: 'failed', error: { code: 131026, title: 'Message undeliverable', message: 'Message undeliverable' } })),
      );
    } else {
      const category = templateCategory(body.template.name);
      later(400, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: body.to!, status: 'sent', category })));
      later(900, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: body.to!, status: 'delivered', category })));
      later(1600, () => postSigned(statusPayload({ wabaId, phoneNumberId: id, wamid, recipient: body.to!, status: 'read', category })));
    }
    return send(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: wamid }] });
  }

  // POST /{ver}/{phoneNumberId}/media
  if (req.method === 'POST' && resource === 'media') {
    await readBody(req);
    return send(res, 200, { id: nextId('media') });
  }

  // /{ver}/{wabaId}/message_templates
  if (resource === 'message_templates') {
    const list = seedTemplates(id);
    if (req.method === 'GET') return send(res, 200, { data: list, paging: { cursors: { before: 'B', after: 'A' } } });
    if (req.method === 'DELETE') {
      const name = url.searchParams.get('name');
      const hsmId = url.searchParams.get('hsm_id');
      // With hsm_id only that language version is deleted; by name alone every language goes.
      templates.set(id, list.filter((t) => (hsmId ? t.id !== hsmId : t.name !== name)));
      return send(res, 200, { success: true });
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Partial<MockTemplate>;
      if (!body.name || !/^[a-z0-9_]+$/.test(body.name)) return graphError(res, 400, 100, 'Invalid template name');
      const template: MockTemplate = {
        id: nextId('T'),
        name: body.name,
        language: body.language ?? 'en_US',
        category: body.category ?? 'MARKETING',
        status: 'PENDING',
        parameter_format: body.parameter_format ?? 'POSITIONAL',
        components: body.components ?? [],
      };
      list.push(template);
      later(env.templateApprovalMs, async () => {
        template.status = 'APPROVED';
        await postSigned(templateStatusPayload({ wabaId: id, id: template.id, name: template.name, language: template.language, event: 'APPROVED' }));
      });
      return send(res, 200, { id: template.id, status: 'PENDING', category: template.category });
    }
  }

  return graphError(res, 404, 100, `Unsupported ${req.method} ${url.pathname}`);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => graphError(res, 500, 1, error instanceof Error ? error.message : 'mock error'));
});

server.listen(env.port, () => console.log(`mock-meta listening on http://localhost:${env.port}`));
